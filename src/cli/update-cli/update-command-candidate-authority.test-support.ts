import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";

const workerDeclaration = runtimeProcessEntrypoints.updateMigratedFinalize;
export const candidateAuthorityWorker = resolveRuntimeWorkerUrl(workerDeclaration);
const sibling = (sourceWorkerName: string, distWorkerPath: string) =>
  resolveRuntimeWorkerUrl({ ...workerDeclaration, sourceWorkerName, distWorkerPath });
// Public health surfaces share this invocation's current-source compiled graph.
export const candidateAuthorityBundledPluginsDir = path.dirname(
  path.dirname(
    fileURLToPath(
      sibling(
        "../../extensions/memory-core/doctor-health-api",
        "extensions/memory-core/doctor-health-api.js",
      ),
    ),
  ),
);

/** The installed-package adapters load real candidate owners; only their I/O is observed. */
export function writeCandidateAuthorityEntrypoints(params: {
  root: string;
  events: string;
  ready: string;
  proceed: string;
  boundary: "candidate" | "doctor";
}): string {
  const workerPath = path.join(params.root, "dist", workerDeclaration.distWorkerPath);
  const cli = sibling("../entry", "entry.js");
  const runtime = sibling("../runtime", "runtime.js");
  const doctorResult = sibling("update-doctor-result", "infra/update-doctor-result.js");
  const bootstrap = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import {setTimeout} from 'node:timers/promises';
    ${candidateAuthorityWorker.pathname.endsWith(".ts") ? `process.env.TSX_TSCONFIG_PATH=${JSON.stringify(path.resolve("tsconfig.json"))}; await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/tsx.mjs")).href)});` : ""}
    const source=${JSON.stringify(candidateAuthorityWorker.href)};
    const role=process.argv[2]==='--doctor'?'doctor':process.argv[2]==='config'?'validate':process.argv.includes('--lint')?'readiness':process.argv[2]==='doctor'?'doctor':'candidate';
    const event=(value)=>fs.appendFileSync(${JSON.stringify(params.events)},JSON.stringify({role,pid:process.pid,ppid:process.ppid,source,...value})+'\\n');
    event({event:'entry',argv:process.argv.slice(2)});
    const open=fsp.open;
    let announced=false;
    fsp.open=async(...args)=>{
      const handle=await open(...args);
      if(!announced && String(args[0]).includes('openclaw-config-backup')) {
        announced=true;
        const {getUpdateDoctorConfigWriteAuthority}=await import(${JSON.stringify(doctorResult.href)});
        const observation={event:'config-backup',role,pid:process.pid,ppid:process.ppid,source,
          doctorAuthority:!!getUpdateDoctorConfigWriteAuthority(process.env.OPENCLAW_CONFIG_PATH)};
        event(observation);
        if(role===${JSON.stringify(params.boundary)}) {
          fs.writeFileSync(${JSON.stringify(params.ready + ".tmp")},JSON.stringify(observation));
          fs.renameSync(${JSON.stringify(params.ready + ".tmp")},${JSON.stringify(params.ready)});
          while(!fs.existsSync(${JSON.stringify(params.proceed)})) await setTimeout(10);
        }
      }
      return handle;
    };
  `;
  fs.mkdirSync(path.dirname(workerPath), { recursive: true });
  fs.writeFileSync(
    workerPath,
    `${bootstrap}\nawait import(${JSON.stringify(candidateAuthorityWorker.href)});`,
  );
  fs.writeFileSync(
    path.join(params.root, "dist", "index.js"),
    `${bootstrap}
    const output={stdout:'',stderr:''};
    for(const name of ['stdout','stderr']) {
      const stream=process[name];
      const write=stream.write.bind(stream);
      stream.write=(chunk,...args)=>{output[name]+=String(chunk);return write(chunk,...args);};
    }
    process.on('exit',(code)=>event({event:'exit',code,...output}));
    const {defaultRuntime}=await import(${JSON.stringify(runtime.href)});
    const writeJson=defaultRuntime.writeJson;
    defaultRuntime.writeJson=(value,...args)=>{
      event({event:'runtime-json',value});
      return writeJson(value,...args);
    };
    const error=defaultRuntime.error;
    defaultRuntime.error=(...args)=>{
      event({event:'runtime-error',args});
      return error(...args);
    };
    // Enter the actual executable bootstrap. Internal owners are bundled chunks,
    // not stable dist/cli or dist/state paths a package adapter may import.
    const {fileURLToPath}=await import('node:url');
    process.argv[1]=fileURLToPath(${JSON.stringify(cli.href)});
    await import(${JSON.stringify(cli.href)});
    `,
  );
  return workerPath;
}
