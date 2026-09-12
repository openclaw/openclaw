// Real installed-child admission; inference/Doctor are fixtures, not repair-effect proof.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const source = (file: string) => pathToFileURL(path.resolve(file)).href;
it.each(["memory", "file"])(
  "preserves %s failure over real IPC without a writable support export",
  async (mode) => {
    const root = await fs.realpath(dirs.make("operator-diagnostics-"));
    const profile = path.join(root, "profile");
    await fs.mkdir(path.join(root, "dist"));
    await fs.mkdir(profile);
    await fs.writeFile(path.join(root, "package.json"), '{"type":"module","name":"openclaw"}');
    // Real filesystem failure; the test does not stub the artifact writer.
    await fs.writeFile(path.join(profile, "logs"), "not a directory");
    const failure = { error: "Original diagnostic from the update" };
    const input = path.join(root, "failure.json");
    await fs.writeFile(input, JSON.stringify(failure));
    const repairCode = `import fs from 'node:fs/promises';
export async function runUpdateRepairLoop(params){
 params.isCurrent(); await fs.writeFile(${JSON.stringify(path.join(root, "context.json"))},JSON.stringify(params.context));
 return {status:'unrepaired',reason:'Fixture does not repair',attempts:[],finalValidation:{ok:false,score:-1,summary:'Fixture error'}};
}`;
    await fs.writeFile(
      path.join(root, "dist/index.js"),
      `
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(/doctor-lint\\.(ts|js)$/.test(url))return {format:'module',shortCircuit:true,source:'export const collectDoctorFindings=async()=>[];'};
 if(/update-repair-agent\\.(ts|js)$/.test(url))return {format:'module',shortCircuit:true,source:${JSON.stringify(repairCode)}};
 return next(url,context);
}});
const {triageCommand}=await import(${JSON.stringify(source("src/commands/triage.ts"))});
const {defaultRuntime}=await import(${JSON.stringify(source("src/runtime.ts"))});
await triageCommand(defaultRuntime,{run:true,json:true,nonInteractive:true,noExport:true});
`,
    );
    const parent = path.join(root, "parent.mjs");
    await fs.writeFile(
      parent,
      `
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(/openclaw-root\\.(ts|js)$/.test(url))return {format:'module',shortCircuit:true,source:${JSON.stringify(`export const resolveOpenClawPackageRoot=async()=>${JSON.stringify(root)}; export const resolveOpenClawPackageRootSync=()=>${JSON.stringify(root)};`)}};
 return next(url,context);
}});
const {runOperatorTriage}=await import(${JSON.stringify(source("src/commands/triage-operator.ts"))});
const {resolveInstallationTarget}=await import(${JSON.stringify(source("src/infra/installation-target-context.ts"))});
const runtime={log:console.log,error:console.error,writeJson:value=>console.log(JSON.stringify(value)),exit:code=>{throw Object.assign(new Error('operator exit'),{code})}};
try{await runOperatorTriage({runtime,target:resolveInstallationTarget(),json:true,noExport:true,${mode === "memory" ? `updateFailure:${JSON.stringify(failure)}` : `updateResult:${JSON.stringify(input)}`}});}catch(error){if(error.code!==1)throw error;}
`,
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", path.resolve("scripts/tsx.mjs"), parent],
      {
        timeout: 60000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          OPENCLAW_TEST_RUNTIME_LOG: "1",
          OPENCLAW_STATE_DIR: profile,
          OPENCLAW_CONFIG_PATH: path.join(profile, "openclaw.json"),
          OPENCLAW_WORKSPACE_DIR: root,
          OPENCLAW_SHELL: "",
          CODEX_THREAD_ID: "",
          OPENCLAW_SUPERVISOR_MODE: "",
          OPENCLAW_SERVICE_MARKER: "",
          OPENCLAW_UPDATE_RUN_HANDOFF: "",
          NODE_OPTIONS: `--import ${path.resolve("scripts/tsx.mjs")}`,
        },
      },
    );
    expect(JSON.parse(result.stdout), result.stderr).toMatchObject({
      installationRoot: root,
      repair: { status: "unrepaired", reason: "Fixture does not repair" },
    });
    expect(JSON.parse(await fs.readFile(path.join(root, "context.json"), "utf8"))).toMatchObject({
      error: failure.error,
    });
    expect(await fs.readFile(path.join(profile, "logs"), "utf8")).toBe("not a directory");
  },
);
