import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { createStateSchemaInlinePlugin } from "../../scripts/lib/state-schema-inline-plugin.mts";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writePackageRoot } from "./package-update-steps.test-support.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";

const exec = promisify(execFile);
const schemas = createStateSchemaInlinePlugin();
const dirs = useAutoCleanupTempDirTracker(afterEach);
const localOverrideWorker = runtimeProcessEntrypoints.packageLocalOverrides;
const localOverrideWorkerPackagePath = path.posix.join("dist", localOverrideWorker.distWorkerPath);

// Copy the real published JS and available native packages into the installation.
// No repository node_modules link may keep the moved updater's dependencies alive.
async function copyRuntime(root: string): Promise<void> {
  const manifest = fileURLToPath(import.meta.resolve("@openclaw/fs-safe/package.json"));
  const require = createRequire(manifest);
  const copy = (source: string, name: string) =>
    fs.cp(path.dirname(source), path.join(root, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  await copy(manifest, "@openclaw/fs-safe");
  const metadata = JSON.parse(await fs.readFile(manifest, "utf8")) as {
    optionalDependencies: Record<string, string>;
  };
  for (const name of Object.keys(metadata.optionalDependencies)) {
    if (!name.startsWith("@openclaw/fs-safe-")) {
      continue;
    }
    let native: string;
    try {
      native = require.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    await copy(native, name);
  }
}

const runner = `
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const [base,scenario,packageRoot,candidate]=process.argv.slice(1);
const doctorFailed=scenario==='doctor failure'||scenario==='late recovery refusal';
const late=scenario==='success'||scenario==='late recovery refusal';
const globalRoot=path.dirname(packageRoot);
const updater=await import(pathToFileURL(path.join(packageRoot,'dist/updater.mjs')).href);
assert(fileURLToPath(updater.installedDependencyUrl).startsWith(packageRoot+path.sep));
async function command(argv,cwd=base){
  try{return {...await exec(argv[0],argv.slice(1),{cwd,env:process.env,timeout:60000,maxBuffer:1024*1024}),code:0}}
  catch(error){return {code:typeof error.code==='number'?error.code:1,stdout:error.stdout??'',stderr:error.stderr??String(error)}}
}
const version=(await command(['npm','--version'])).stdout.trim();
const [major,minor]=version.split('.').map(Number);
const lifecyclePolicy=major>=12?'allow-scripts':major===11&&minor>=16?'allow-scripts-advisory':'unflagged';
let transaction;
const result=await updater.runGlobalPackageUpdateSteps({
  installTarget:{manager:'npm',command:'npm',globalRoot,packageRoot,npmOwner:{version,lifecyclePolicy}},
  packageName:'openclaw',packageRoot,installSpec:candidate,requirePackageReplacement:true,env:process.env,timeoutMs:60000,
  localOverrides:{reapply:true,env:process.env},runCommand:(argv,options)=>command(argv,options.cwd),
  runStep:async({name,argv,cwd})=>{const value=await command(argv,cwd);return {name,command:argv.join(' '),cwd:cwd??base,durationMs:0,exitCode:value.code,stdoutTail:value.stdout,stderrTail:value.stderr}},
  beforeActivate:async()=>{if(late)await fs.writeFile(path.join(packageRoot,'dist/late.js'),'late edit\\n')},
  onTransaction:value=>{transaction=value},
  postVerifyStep:async root=>({name:'fixture doctor',command:'fixture doctor',cwd:root,durationMs:0,exitCode:doctorFailed?1:0})
});
assert(transaction,JSON.stringify(result));
const overrides=result.localOverrides;
let rollback;
if(doctorFailed)rollback=await transaction.rollback(()=>{});
const completion=await transaction.complete({activationVerified:!doctorFailed},()=>{});
const read=(root,file)=>root?fs.readFile(path.join(root,file),'utf8').catch(()=>null):null;
const cli=await command([process.execPath,path.join(packageRoot,'dist/index.js')]);
const observed={failedStep:result.failedStep?.name??null,restartSafe:result.recovery.serviceRestartSafe,
  overrideStatus:overrides?.status,applied:overrides?.applied,rollbackCode:rollback?.exitCode,completionCode:completion?.exitCode??null,
  hasRecoveryDir:overrides?.recoveryDir!==undefined,
  version:await fs.readFile(path.join(packageRoot,'package.json'),'utf8').then(value=>JSON.parse(value).version,()=>null),
  index:await read(packageRoot,'dist/index.js'),late:await read(packageRoot,'dist/late.js'),cliCode:cli.code,cliOutput:cli.stdout.trim(),
  savedIndex:await read(overrides?.recoveryDir,'files/dist/index.js'),savedLate:await read(overrides?.recoveryDir,'files/dist/late.js'),
  notice:result.steps.some(step=>step.name==='local-package-overrides'&&step.advisory?.message.includes(overrides.recoveryDir)),
  backupPresent:await fs.stat(transaction.backupRoot).then(()=>true,()=>false)};
console.log(JSON.stringify(observed));
`;

it.each(["success", "doctor failure", "unchanged", "legacy", "late recovery refusal"])(
  "real npm self-update keeps its native runtime and recovery contract: %s",
  async (scenario) => {
    const base = dirs.make("self-replay-");
    const source = path.join(base, "old");
    const candidateSource = path.join(base, "candidate");
    const prefix = path.join(base, "prefix");
    const root = path.join(
      prefix,
      process.platform === "win32" ? "node_modules" : "lib/node_modules",
      "openclaw",
    );
    const env = {
      ...process.env,
      HOME: base,
      OPENCLAW_STATE_DIR: path.join(base, "state"),
      npm_config_cache: path.join(base, "cache"),
      npm_config_userconfig: path.join(base, "npmrc"),
    };
    await fs.writeFile(env.npm_config_userconfig, "");
    const run = (command: string, args: string[], cwd = base) =>
      exec(command, args, { cwd, env, timeout: 60_000, maxBuffer: 1024 * 1024 });
    const upstream = '#!/usr/bin/env node\nconsole.log("upstream");\n';
    const local = '#!/usr/bin/env node\nconsole.log("operator override");\n';
    await writePackageRoot(source, "2026.9.3");
    await fs.writeFile(path.join(source, "dist/index.js"), upstream, { mode: 0o755 });
    await fs.chmod(path.join(source, "dist/index.js"), 0o755);
    await build({
      stdin: {
        contents:
          'export { runGlobalPackageUpdateSteps } from "./src/infra/package-update-steps.ts"; export const installedDependencyUrl = import.meta.resolve("@openclaw/fs-safe/root");',
        resolveDir: process.cwd(),
      },
      outfile: path.join(source, "dist/updater.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      plugins: [
        {
          name: schemas.name,
          setup(bundle) {
            bundle.onLoad({ filter: /./ }, ({ path: modulePath }) => {
              // This is a one-shot build, not a watched esbuild context.
              const result = schemas.load.call({ addWatchFile() {} }, modulePath);
              return result ? { contents: result.code, loader: result.moduleType } : undefined;
            });
          },
        },
      ],
      external: ["@openclaw/fs-safe", "@openclaw/fs-safe/*"],
      banner: {
        js: 'import { createRequire as createFixtureRequire } from "node:module"; const require = createFixtureRequire(import.meta.url);',
      },
      logLevel: "silent",
    });
    await build({
      entryPoints: [path.resolve(localOverrideWorker.sourceModulePath)],
      outfile: path.join(source, ...localOverrideWorkerPackagePath.split("/")),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      logLevel: "silent",
    });
    await fs.cp(source, candidateSource, { recursive: true });
    async function pack(directory: string, version: string) {
      await fs.writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version,
          type: "module",
          files: ["dist"],
          bin: { openclaw: "dist/index.js" },
        }),
      );
      await writePackageDistInventory(directory);
      if (scenario === "legacy" && directory === source) {
        await fs.rm(path.join(directory, "dist/postinstall-content-inventory.json"));
        await fs.writeFile(
          path.join(directory, "dist/postinstall-inventory.json"),
          JSON.stringify(["dist/index.js", "dist/updater.mjs", localOverrideWorkerPackagePath]),
        );
      }
      await run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", base],
        directory,
      );
      return path.join(base, `openclaw-${version}.tgz`);
    }
    const old = await pack(source, "2026.9.3");
    const candidate = await pack(candidateSource, "2026.9.4");
    await run("npm", [
      "install",
      "-g",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      old,
    ]);
    await copyRuntime(root);
    if (scenario !== "unchanged") {
      await fs.writeFile(path.join(root, "dist/index.js"), local);
    }
    const { stdout } = await run(process.execPath, [
      "--input-type=module",
      "--eval",
      runner,
      base,
      scenario,
      root,
      candidate,
    ]);
    const observed = JSON.parse(stdout.trim());
    const failed = scenario === "doctor failure" || scenario === "late recovery refusal";
    const late = scenario === "success" || scenario === "late recovery refusal";
    const unchanged = scenario === "unchanged";
    const legacy = scenario === "legacy";
    expect(observed, stdout).toMatchObject({
      failedStep: failed ? "fixture doctor" : null,
      restartSafe: !failed,
      overrideStatus: unchanged ? "none" : legacy ? "preserved" : "applied",
      applied: unchanged || legacy ? 0 : late ? 2 : 1,
      index: unchanged || legacy ? upstream : local,
      cliCode: 0,
      cliOutput: unchanged || legacy ? "upstream" : "operator override",
      late: late ? "late edit\n" : null,
      savedIndex: unchanged ? null : local,
      savedLate: late ? "late edit\n" : null,
      hasRecoveryDir: !unchanged,
      notice: !unchanged,
      backupPresent: scenario === "late recovery refusal",
      version: scenario === "doctor failure" ? "2026.9.3" : "2026.9.4",
      completionCode: scenario === "late recovery refusal" ? 1 : null,
      ...(failed ? { rollbackCode: scenario === "doctor failure" ? 0 : 1 } : {}),
    });
  },
  120_000,
);
