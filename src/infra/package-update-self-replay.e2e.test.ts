import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTestDir } from "../test-helpers/temp-dir.js";

const exec = promisify(execFile);

// Copy the real published JS and available native packages into the installation.
// No repository node_modules link may keep the moved updater's dependencies alive.
async function copyPublicationRuntime(packageRoot: string): Promise<void> {
  const manifest = fileURLToPath(import.meta.resolve("@openclaw/fs-safe/package.json"));
  const require = createRequire(manifest);
  await fs.cp(path.dirname(manifest), path.join(packageRoot, "node_modules/@openclaw/fs-safe"), {
    recursive: true,
    dereference: true,
  });
  const metadata = JSON.parse(await fs.readFile(manifest, "utf8")) as {
    optionalDependencies: Record<string, string>;
  };
  for (const name of Object.keys(metadata.optionalDependencies)) {
    if (!name.startsWith("@openclaw/fs-safe-")) {
      continue;
    }
    let nativeManifest: string;
    try {
      nativeManifest = require.resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    await fs.cp(path.dirname(nativeManifest), path.join(packageRoot, "node_modules", name), {
      recursive: true,
      dereference: true,
    });
  }
}

const runner = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const [base,scenario]=process.argv.slice(1);
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
  postVerifyStep:async root=>({name:'fixture doctor',command:'fixture doctor',cwd:root,durationMs:0,exitCode:scenario==='doctor failure'?1:0})
});
let rollback;
if(result.status==='committed'&&scenario==='doctor failure'){
  rollback=await transaction.rollback(()=>{});
  await transaction.complete({activationVerified:false},()=>{});
}else if(result.status==='committed'){
  await transaction.complete({activationVerified:true},()=>{});
}
const observed={result,overrides,rollback,loadedFrom:updater.installedDependencyUrl,
  version:await fs.readFile(path.join(packageRoot,'package.json'),'utf8').then(value=>JSON.parse(value).version,()=>null),
  index:await fs.readFile(path.join(packageRoot,'dist/index.js'),'utf8').catch(()=>null),
  late:await fs.readFile(path.join(packageRoot,'dist/late.js'),'utf8').catch(()=>null),
  backupPresent:await fs.stat(transaction.backupRoot).then(()=>true,()=>false)};
console.log(JSON.stringify(observed));
`;

describe("local replay from the installation being replaced", () => {
  it.each(["success", "doctor failure"])(
    "%s keeps the updater's external native dependency runtime available",
    async (scenario) => {
      await withTestDir({ prefix: "openclaw-self-replay-" }, async (requestedBase) => {
        const base = await fs.realpath(requestedBase);
        const packageRoot = path.join(base, "prefix/lib/node_modules/openclaw");
        const stagedRoot = path.join(base, "stage/lib/node_modules/openclaw");
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "1.0.0", type: "module" }),
        );
        await fs.writeFile(path.join(packageRoot, "dist/index.js"), "export {};\n");
        await build({
          stdin: {
            contents:
              'export { swapStagedPackageInstall } from "./src/infra/package-update-swap.ts"; export const installedDependencyUrl = import.meta.resolve("@openclaw/fs-safe/root");',
            resolveDir: process.cwd(),
          },
          outfile: path.join(packageRoot, "dist/updater.mjs"),
          bundle: true,
          platform: "node",
          format: "esm",
          target: "node22",
          external: ["@openclaw/fs-safe", "@openclaw/fs-safe/*"],
          banner: {
            js: 'import { createRequire as createFixtureRequire } from "node:module"; const require = createFixtureRequire(import.meta.url);',
          },
          logLevel: "silent",
        });
        await copyPublicationRuntime(packageRoot);
        await writePackageDistInventory(packageRoot);
        await fs.cp(packageRoot, stagedRoot, { recursive: true });
        await fs.writeFile(
          path.join(stagedRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2.0.0", type: "module" }),
        );
        await fs.writeFile(path.join(packageRoot, "dist/index.js"), "operator edit\n");
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
        expect(observed.result.status, stdout).toBe("committed");
        expect(observed.overrides.status).toBe("applied");
        expect(observed.overrides.applied).toBe(scenario === "success" ? 2 : 1);
        expect(observed.index).toBe("operator edit\n");
        expect(observed.late).toBe(scenario === "success" ? "late edit\n" : null);
        expect(observed.backupPresent).toBe(false);
        expect(observed.version).toBe(scenario === "success" ? "2.0.0" : "1.0.0");
        if (scenario === "doctor failure") {
          expect(observed.rollback.exitCode).toBe(0);
        }
      });
    },
    120_000,
  );
});
