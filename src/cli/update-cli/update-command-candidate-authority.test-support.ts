import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";

const workerDeclaration = runtimeProcessEntrypoints.updateMigratedFinalize;
const sourceWorker = resolveRuntimeWorkerUrl(workerDeclaration);

export async function prepareCandidateAuthorityRuntime(root: string) {
  let installedRoot: string | undefined;
  // Standalone Vitest/watch keeps its documented source execution path.
  if (!sourceWorker.pathname.endsWith(".ts")) {
    const preparedRoot = fileURLToPath(new URL("../../", sourceWorker));
    await fs.promises.cp(path.join(preparedRoot, "dist"), path.join(root, "dist"), {
      recursive: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
    await fs.promises.copyFile(
      path.join(preparedRoot, "node-host-launcher.mjs"),
      path.join(root, "node-host-launcher.mjs"),
    );
    const dependencies = path.resolve("node_modules");
    const fixtureDependencies = path.join(root, "node_modules");
    await fs.promises.mkdir(fixtureDependencies);
    for (const entry of await fs.promises.readdir(dependencies, { withFileTypes: true })) {
      if (entry.name === "openclaw" || (!entry.isDirectory() && !entry.isSymbolicLink())) {
        continue;
      }
      const source = path.join(dependencies, entry.name);
      await fs.promises.symlink(
        source,
        path.join(fixtureDependencies, entry.name),
        (await fs.promises.stat(source)).isDirectory()
          ? process.platform === "win32"
            ? "junction"
            : "dir"
          : "file",
      );
    }
    await fs.promises.symlink(
      root,
      path.join(fixtureDependencies, "openclaw"),
      process.platform === "win32" ? "junction" : "dir",
    );
    // Doctor resolves its loaded module's package before argv/cwd. A package
    // boundary prevents it from finding and rebuilding the source checkout's UI.
    await fs.promises.copyFile(path.resolve("package.json"), path.join(root, "package.json"));
    installedRoot = root;
  }
  const sibling = (sourceWorkerName: string, distWorkerPath: string) =>
    resolveRuntimeWorkerUrl({
      ...workerDeclaration,
      sourceWorkerName,
      distWorkerPath,
      root: installedRoot,
    });
  return {
    worker: resolveRuntimeWorkerUrl({ ...workerDeclaration, root: installedRoot }),
    cli: sibling("../entry", "entry.js"),
    runtime: sibling("../runtime", "runtime.js"),
    doctorResult: sibling("update-doctor-result", "infra/update-doctor-result.js"),
    bundledPluginsDir: path.dirname(
      path.dirname(
        fileURLToPath(
          sibling(
            "../../extensions/memory-core/doctor-health-api",
            "extensions/memory-core/doctor-health-api.js",
          ),
        ),
      ),
    ),
  };
}

/** The installed-package adapters load real candidate owners; only their I/O is observed. */
export function writeCandidateAuthorityEntrypoints(params: {
  runtime: Awaited<ReturnType<typeof prepareCandidateAuthorityRuntime>>;
  root: string;
  events: string;
  ready: string;
  proceed: string;
  boundary: "candidate" | "doctor";
}): string {
  const workerPath = path.join(params.root, "dist", workerDeclaration.distWorkerPath);
  const { worker: candidateAuthorityWorker, cli, runtime, doctorResult } = params.runtime;
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
