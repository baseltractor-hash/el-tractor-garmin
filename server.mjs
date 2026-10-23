import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const ORIGIN='https://personal.connectapi.garmin.com';
const TOKEN='/personalapitoken-service/personal-api/personal-api-key/token';
export function allowedPath(value,method){
 if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||value.includes('%')||value.includes('\\'))return false;
 const u=new URL(value,ORIGIN);if(u.origin!==ORIGIN)return false;
 if(u.pathname===TOKEN)return method==='POST'&&!u.search;
 if(method!=='GET')return false;
 if(/^\/hrv-service\/hrv\/\d{4}-\d{2}-\d{2}$/.test(u.pathname))return !u.search;
 const params={'/sleep-service/sleep/dailySleep':['date'],'/usersummary-service/usersummary/daily':['calendarDate'],'/activitylist-service/activities/search/activities':['start','limit','startDate','endDate','excludeChildren','sortOrder']}[u.pathname];
 return !!params&&[...u.searchParams.keys()].every(k=>params.includes(k));
}
function authorized(value,secret){if(typeof value!=='string')return false;const a=Buffer.from(value),b=Buffer.from('Bearer '+secret);return a.length===b.length&&timingSafeEqual(a,b)}
export function makeServer({secret,upstream=fetch}={}){
 if(typeof secret!=='string'||secret.length<32)throw new Error('RELAY_SECRET must contain at least 32 characters.');
 let active=0;
 return createServer(async(req,res)=>{
  const send=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body))};
  if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true});
  if(!authorized(req.headers.authorization,secret))return send(401,{error:'Unauthorized'});
  if(req.method!=='POST'||!['/fetch','/probe'].includes(req.url))return send(404,{error:'Not found'});
  if(active>=8)return send(429,{error:'Busy'});active++;
  try{
   if(req.url==='/probe'){const r=await upstream(ORIGIN+TOKEN,{method:'POST',headers:{Authorization:'ApiKey connectivity-probe-not-a-real-key'},redirect:'manual',signal:AbortSignal.timeout(15000)});await r.body?.cancel();return send(200,{reachable:r.status===401,upstreamStatus:r.status});}
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>16384)return send(413,{error:'Request too large'});}
   let data;try{data=JSON.parse(body)}catch{return send(400,{error:'Invalid JSON'})}
   if(!allowedPath(data.path,data.method)||typeof data.authorization!=='string'||!/^(ApiKey|Bearer) [\x21-\x7e]{8,8192}$/.test(data.authorization))return send(400,{error:'Unsupported Garmin request'});
   const r=await upstream(ORIGIN+data.path,{method:data.method,headers:{Authorization:data.authorization,Accept:'application/json, text/plain'},redirect:'manual',signal:AbortSignal.timeout(25000)});
   if(r.status>=300&&r.status<400){await r.body?.cancel();return send(502,{error:'Garmin redirect refused'});}
   if(r.status===204){res.writeHead(204,{'Cache-Control':'no-store'});return res.end();}
   const chunks=[];let length=0;for await(const chunk of r.body||[]){length+=chunk.byteLength;if(length>10*1024*1024)return send(502,{error:'Response too large'});chunks.push(Buffer.from(chunk));}
   res.writeHead(r.status,{'Content-Type':r.headers.get('Content-Type')||'text/plain','Cache-Control':'no-store'});res.end(Buffer.concat(chunks));
  }catch{return send(502,{error:'Garmin connection failed'});}finally{active--;}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const server=makeServer({secret:process.env.RELAY_SECRET});server.listen(Number(process.env.PORT||10000),'0.0.0.0');process.on('SIGTERM',()=>server.close());}
