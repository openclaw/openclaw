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

const exec = promisify(execFile);
const schemas = createStateSchemaInlinePlugin();
const dirs = useAutoCleanupTempDirTracker(afterEach);

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
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [base,scenario]=process.argv.slice(1);
const doctorFailed=scenario==='doctor failure';
const prefix=path.join(base,'prefix');
const globalRoot=path.join(prefix,'lib/node_modules');
const packageRoot=path.join(globalRoot,'openclaw');
const stagePrefix=path.join(base,'stage');
const stagedRoot=path.join(stagePrefix,'lib/node_modules/openclaw');
const updater=await import(pathToFileURL(path.join(packageRoot,'dist/updater.mjs')).href);
assert(fileURLToPath(updater.installedDependencyUrl).startsWith(packageRoot+path.sep));
let transaction;
let overrides;
const result=await updater.swapStagedPackageInstall({
  stage:{prefix:stagePrefix,packageRoot:stagedRoot,layout:{prefix:stagePrefix,globalRoot:path.dirname(stagedRoot),binDir:path.join(stagePrefix,'bin')},installTarget:{manager:'npm',command:'npm',globalRoot:path.dirname(stagedRoot),packageRoot:stagedRoot}},
  installTarget:{manager:'npm',command:'npm',globalRoot,packageRoot},
  packageName:'openclaw',localOverrides:{reapply:true,env:process.env},
  beforeActivate:async()=>{if(scenario==='success')await fs.writeFile(path.join(packageRoot,'dist/late.js'),'late edit\\n')},
  onTransaction:value=>{transaction=value},onLocalOverrides:value=>{overrides=value},
  postVerifyStep:async root=>({name:'fixture doctor',command:'fixture doctor',cwd:root,durationMs:0,exitCode:doctorFailed?1:0})
});
let rollback;
if(result.status==='committed'){
  if(doctorFailed)rollback=await transaction.rollback(()=>{});
  await transaction.complete({activationVerified:!doctorFailed},()=>{});
}
const observed={status:result.status,overrideStatus:overrides?.status,applied:overrides?.applied,rollbackCode:rollback?.exitCode,
  version:await fs.readFile(path.join(packageRoot,'package.json'),'utf8').then(value=>JSON.parse(value).version,()=>null),
  index:await fs.readFile(path.join(packageRoot,'dist/index.js'),'utf8').catch(()=>null),
  late:await fs.readFile(path.join(packageRoot,'dist/late.js'),'utf8').catch(()=>null),
  backupPresent:await fs.stat(transaction.backupRoot).then(()=>true,()=>false)};
console.log(JSON.stringify(observed));
`;

it.each(["success", "doctor failure"])(
  "self-replay %s keeps the updater's native dependency available",
  async (scenario) => {
    const base = dirs.make("self-replay-");
    const root = path.join(base, "prefix/lib/node_modules/openclaw");
    const staged = path.join(base, "stage/lib/node_modules/openclaw");
    await writePackageRoot(root, "1.0.0");
    await build({
      stdin: {
        contents:
          'export { swapStagedPackageInstall } from "./src/infra/package-update-swap.ts"; export const installedDependencyUrl = import.meta.resolve("@openclaw/fs-safe/root");',
        resolveDir: process.cwd(),
      },
      outfile: path.join(root, "dist/updater.mjs"),
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
    await copyRuntime(root);
    await writePackageDistInventory(root);
    await fs.cp(root, staged, { recursive: true });
    await writePackageRoot(staged, "2.0.0");
    await fs.writeFile(path.join(root, "dist/index.js"), "operator edit\n");
    const { stdout } = await exec(
      process.execPath,
      ["--input-type=module", "--eval", runner, base, scenario],
      {
        cwd: base,
        env: { ...process.env, HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state") },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const observed = JSON.parse(stdout.trim());
    const success = scenario === "success";
    expect(observed, stdout).toMatchObject({
      status: "committed",
      overrideStatus: "applied",
      applied: success ? 2 : 1,
      index: "operator edit\n",
      late: success ? "late edit\n" : null,
      backupPresent: false,
      version: success ? "2.0.0" : "1.0.0",
      ...(success ? {} : { rollbackCode: 0 }),
    });
  },
  120_000,
);
