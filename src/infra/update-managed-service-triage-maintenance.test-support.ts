// Real maintenance owners in a real fixing descendant; only the native service is synthetic.
import fs from "node:fs/promises";
import path from "node:path";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageMaintenanceRuntimeEntrypoints } from "./triage-runtime.test-support.js";

export async function writeTriageMaintenanceProbe(params: {
  root: string;
  primaryFile: string;
  unit: string;
  events: string;
}): Promise<string> {
  const { root, primaryFile, unit, events } = params;
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  const script = path.join(root, "maintenance.mjs");
  await fs.writeFile(
    script,
    `
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { mock } from 'node:test';
const root=${JSON.stringify(root)}, primaryFile=${JSON.stringify(primaryFile)};
const event=(kind,data={})=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({kind,pid:process.pid,...data})+'\\n');
const started=performance.now(); let sequence=0;
const phase=(phase,data={})=>event('maintenance-phase',{phase,ppid:process.ppid,sequence:++sequence,elapsedMs:performance.now()-started,...data});
phase('entry');
const native=async(action)=>{
  phase('native-begin',{action});
  const child=spawn('systemctl',['--user',action,${JSON.stringify(unit)}],{stdio:'ignore'});
  child.once('error',error=>phase('native-error',{error:String(error)}));
  await new Promise(resolve=>child.once('exit',resolve));
  phase('native-end',{action});
};
// Keep the real ownership/selector checks, using a synthetic account home.
const user=os.userInfo();
os.userInfo=()=>({...user,homedir:root});
const serviceUrl=${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.service).href)};
phase('service-import-begin');
const actual=await import(serviceUrl);
phase('service-import-end');
const service={
  isLoaded:async()=>{phase('isLoaded');return true;},
  readCommand:async()=>{phase('readCommand');return {programArguments:[process.execPath,root+'/dist/index.js','gateway','run'],environment:{}};},
  readRuntime:async()=>{
    phase('readRuntime');
    const primary=JSON.parse(fs.readFileSync(primaryFile,'utf8'));
    return {status:primary.active?'running':'stopped',pid:primary.active?primary.pid:undefined};
  },
  stop:()=>native('stop'),
  restart:()=>native('restart'),
};
phase('mock-begin');
mock.module(serviceUrl,{namedExports:{...actual,resolveGatewayService:()=>{phase('resolveGatewayService');return service;}}});
phase('mock-end');
phase('doctor-import-begin');
const {beginDoctorMaintenance}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.doctor).href)});
phase('doctor-import-end');
phase('update-import-begin');
const {maybeStopManagedServiceBeforeMutableUpdate}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(triageMaintenanceRuntimeEntrypoints.update).href)});
phase('update-import-end');
if(process.argv[2]==='inactive'){
  const primary=JSON.parse(fs.readFileSync(primaryFile,'utf8'));
  fs.writeFileSync(primaryFile,JSON.stringify({...primary,active:false}));
  // Exercise Linux's inactive-unit policy on macOS too. No PID/native probes
  // are needed on the corrected inactive branch; this is not native proof.
  Object.defineProperty(process,'platform',{value:'linux'});
}
try {
  phase('update-begin');
  const result=await maybeStopManagedServiceBeforeMutableUpdate({root,updateInstallKind:'package',shouldRestart:true,jsonMode:true});
  event('maintenance-result',{result:{stopped:result.stopped,inspected:result.inspected,running:result.running,blockMessage:result.blockMessage,skip:result.serviceMutationSkipMessage,kind:result.serviceUpdateVerdict?.kind}});
  phase('doctor-begin');
  const maintenance=await beginDoctorMaintenance({root,options:{repair:true},runtime:{log:()=>{},error:()=>{},exit:()=>{throw new Error('unexpected exit')}}});
  phase('doctor-release');
  await maintenance?.release();
  event('doctor-maintenance',{admitted:!!maintenance});
} catch(error){event('maintenance-refused',{error:String(error)});}
phase('mock-restore');
mock.restoreAll();
phase('done');
`,
  );
  return script;
}
