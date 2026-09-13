import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { convertPathToPattern } from "tinyglobby";
import { writeFixture } from "./vitest-worker-artifacts.test-support.js";

const implementationFiles = [
  "scripts/lib/vitest-worker-artifacts.mts",
  "scripts/lib/vitest-worker-compiler.mts",
  "scripts/lib/vitest-worker-run.mts",
  "scripts/lib/vitest-worker-bootstrap.mts",
  "scripts/lib/vitest-cli.mts",
  "scripts/lib/vitest-cli-mode.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/windows-taskkill.mjs",
  "scripts/windows-cmd-helpers.mjs",
  "scripts/lib/managed-handoff-build-config.mts",
  "scripts/lib/state-schema-inline-plugin.mts",
  "scripts/lib/runtime-process-core-build-entries.mts",
  "test/vitest/vitest.worker-artifacts.ts",
  "src/infra/runtime-worker-url.ts",
  "src/daemon/runtime-binary.ts",
  "src/infra/update-managed-service-handoff-runtime-assets.ts",
  "src/infra/package-update-activation-runtime-assets.ts",
  "test/helpers/run-node-script.ts",
  "test/helpers/bounded-child-output.ts",
] as const;

// Exercise the actual transport/compiler/cache owner with a small catalog, not
// every product worker. The sibling workerProbe keeps the full-graph contract.
export function createWorkerTransformsFixture(directory: string, layout: "single" | "projects") {
  const root = process.cwd();
  const implementationHashes = Object.fromEntries(
    implementationFiles.map((name) => {
      const bytes = fs.readFileSync(path.join(root, name));
      const filename = path.join(directory, name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, bytes);
      return [name, createHash("sha256").update(bytes).digest("hex")];
    }),
  );
  const assertImplementationCopies = () => {
    for (const [name, hash] of Object.entries(implementationHashes)) {
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(directory, name)))
          .digest("hex"),
        hash,
        name,
      );
    }
  };
  const write = (name: string, source: string) => writeFixture(directory, name, source);
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  write(
    "package.json",
    JSON.stringify({
      name: "vitest-worker-transforms-fixture",
      private: true,
      type: "module",
      devDependencies: Object.fromEntries(
        ["tsdown", "tsx", "vitest"].map((name) => [name, packageJson.devDependencies[name]]),
      ),
    }),
  );
  fs.symlinkSync(
    fs.realpathSync(path.join(root, "node_modules")),
    path.join(directory, "node_modules"),
    "junction",
  );
  write(
    "tsconfig.json",
    '{"compilerOptions":{"target":"ESNext","module":"ESNext","moduleResolution":"Bundler"}}',
  );
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
  write(
    "scripts/lib/vitest-worker-declarations.mts",
    `
    export const runtimeProcessDeclarationEntries = {
      "infra/runtime-process-entrypoints": "src/infra/runtime-process-entrypoints.ts",
    };
    export const vitestWorkerDeclarationEntries = {
      ...runtimeProcessDeclarationEntries,
      "infra/update-managed-service-handoff-runtime-assets": "src/infra/update-managed-service-handoff-runtime-assets.ts",
      "infra/package-update-activation-runtime-assets": "src/infra/package-update-activation-runtime-assets.ts",
    };
    `,
  );
  write(
    "scripts/lib/runtime-process-build-entries.mts",
    'export {runtimeProcessCoreBuildEntries as runtimeProcessBuildEntries} from "./runtime-process-core-build-entries.mts";',
  );
  write(
    "scripts/lib/vitest-worker-build-entries.mts",
    'export {runtimeProcessBuildEntries as vitestWorkerBuildEntries} from "./runtime-process-build-entries.mts";',
  );
  write(
    "src/infra/runtime-process-entrypoints.ts",
    `
    export const runtimeProcessEntrypoints = {
      process: {currentModuleUrl:import.meta.url,sourceWorkerName:"fixture-worker",distWorkerPath:"infra/fixture-worker.js"},
      thread: {currentModuleUrl:import.meta.url,sourceWorkerName:"fixture-thread",distWorkerPath:"infra/fixture-thread.js"},
      sqliteReadOnly: {currentModuleUrl:import.meta.url,sourceWorkerName:"fixture-sqlite",distWorkerPath:"infra/fixture-sqlite.js"},
    };
    `,
  );
  write(
    "src/infra/fixture-worker.ts",
    'const value: string = "process"; console.log(JSON.stringify({value,pid:process.pid}));',
  );
  write(
    "src/infra/fixture-thread.ts",
    'import {parentPort,threadId} from "node:worker_threads"; const value: string = "thread"; parentPort!.postMessage({value,pid:process.pid,threadId});',
  );
  write("src/infra/fixture-sealed-leaf.ts", 'export const value: string = "sealed";');
  write("src/infra/fixture-sqlite.ts", 'const value: string = "sqlite"; console.log(value);');
  for (const name of ["update-managed-service-handoff", "package-update-activation"]) {
    write(
      `src/infra/${name}-sealed.ts`,
      `
      import assert from "node:assert/strict";
      import {value} from "./fixture-sealed-leaf.js";
      declare const SEALED_RUNTIME_BUILD: boolean;
      assert.equal(SEALED_RUNTIME_BUILD, true);
      assert.equal(value, "sealed");
      `,
    );
  }
  const parent = write(
    "src/infra/fixture-parent.ts",
    `
    import assert from "node:assert/strict";
    import {Worker} from "node:worker_threads";
    import {runtimeProcessEntrypoints} from "./runtime-process-entrypoints.js";
    import {resolveRuntimeWorkerUrl,resolveRuntimeWorkerArgv} from "./runtime-worker-url.js";
    import {runNodeScript} from "../../test/helpers/run-node-script.js";
    export async function probe(signal: AbortSignal) {
      const generation = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.process);
      const args = resolveRuntimeWorkerArgv(generation);
      const child = await runNodeScript(args, process.env, undefined, {
        signal,maxBuffer:65536,requireProcessTreeExit:process.platform !== "win32",
      });
      assert.equal(child.error, undefined);
      assert.equal(child.status, 0, child.stderr);
      const threadUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.thread);
      const worker = new Worker(threadUrl, {execArgv:resolveRuntimeWorkerArgv(threadUrl).slice(0,-1)});
      const stop = () => {void worker.terminate();};
      try {
        const thread = await new Promise((resolve,reject) => {
          let message;
          worker.once("message", value => {message = value;});
          worker.once("error", reject);
          worker.once("exit", code => {
            if (code === 0) {resolve(message);}
            else {reject(new Error("Fixture thread failed: " + code));}
          });
          signal.addEventListener("abort", stop, {once:true});
          if (signal.aborted) {stop();}
        });
        return {generation:generation.href,args,threadUrl:threadUrl.href,child:JSON.parse(child.stdout),thread};
      } finally {
        signal.removeEventListener("abort", stop);
        await worker.terminate();
      }
    }
    `,
  );
  const value = write("value.ts", 'export const value: string = "first";');
  const configuredValue = write(
    "configured-value.ts",
    'export const value: string = "configured";',
  );
  const test = write(
    "child.test.ts",
    `
    import fs from "node:fs";
    import path from "node:path";
    import {it,expect,inject} from "vitest";
    import {value} from "#fixture-value";
    import {probe} from "./src/infra/fixture-parent.js";
    it("runs real process and thread payloads", async ({signal}) => {
      const launcherArgv = inject("launcherArgv");
      expect(path.isAbsolute(launcherArgv[1])).toBe(true);
      expect(path.basename(launcherArgv[1])).toBe("vitest.mjs");
      const observed = await probe(signal);
      expect(observed.child.value).toBe("process");
      expect(observed.child.pid).not.toBe(process.pid);
      expect(observed.thread).toEqual({value:"thread",pid:process.pid,threadId:expect.any(Number)});
      expect(observed.thread.threadId).toBeGreaterThan(0);
      fs.appendFileSync(${JSON.stringify(path.join(directory, "observations.jsonl"))},JSON.stringify({...observed,value,configValue:inject("configValue")})+"\\n");
      fs.appendFileSync(${JSON.stringify(path.join(directory, "generations.jsonl"))},JSON.stringify(observed.generation)+"\\n");
    });
    `,
  );
  const cacheDirectory = path.join(directory, "cache");
  const cacheConfig = { fsModuleCache: true, fsModuleCachePath: cacheDirectory };
  const config = write(
    "vitest.config.mts",
    `
    import fs from "node:fs";
    import {compiledSubprocessesPlugin} from "./test/vitest/vitest.worker-artifacts.ts";
    const probe = {name:"fixture:transform-counter",transform(code,id) {
      if (${JSON.stringify([value, configuredValue, parent].map((file) => file.replaceAll("\\", "/")))}.includes(id)) {
        fs.appendFileSync(${JSON.stringify(path.join(directory, "transforms.jsonl"))},JSON.stringify(id)+"\\n");
      }
    }};
    const project = name => ({
      extends:false,plugins:[compiledSubprocessesPlugin(),probe],
      resolve:{alias:[{find:"#fixture-value",replacement:${JSON.stringify(value)}}]},
      test:{name,include:[${JSON.stringify(convertPathToPattern(test))}],pool:"forks",maxWorkers:1,testTimeout:10000,
        ...${JSON.stringify(cacheConfig)},provide:{launcherArgv:process.argv,configValue:"first"}},
    });
    export default {root:${JSON.stringify(directory)},${layout === "single" ? "...project('first')" : `plugins:[compiledSubprocessesPlugin()],test:{...${JSON.stringify(cacheConfig)},projects:[project("first"),project("second")]}`}};
    `,
  );
  const driver = write(
    "scripts/fixture-run.mjs",
    `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import path from "node:path";
    import {fileURLToPath} from "node:url";
    import {runManagedCommand} from "./lib/managed-child-process.mts";
    import {createVitestWorkerRun} from "./lib/vitest-worker-run.mts";
    const root = fileURLToPath(new URL("../",import.meta.url));
    const owner = createVitestWorkerRun();
    let receipt;
    let failure;
    try {
      let child;
      const completion = runManagedCommand({
        bin:process.execPath,
        args:[path.join(root,"scripts/lib/vitest-worker-bootstrap.mts"),owner.descriptor.directory,
          path.join(root,"node_modules/vitest/vitest.mjs"),...process.argv.slice(2)],
        cwd:root,env:process.env,stdio:["ignore","inherit","inherit","ipc"],
        requireProcessTreeExit:process.platform !== "win32",
        onReady(value) {child = value;},
      });
      assert.equal(await (child ? owner.borrow(child,completion) : completion),0);
      const manifest = JSON.parse(fs.readFileSync(path.join(owner.descriptor.directory,"manifest.json"),"utf8"));
      assert.ok(manifest.outputs["infra/fixture-sqlite.js"]);
      const sealed = ["managed-handoff-runtime.mjs","package-update-activation-recovery.mjs"];
      for (const name of sealed) {
        assert.ok(manifest.outputs[name]);
        const independent = fs.mkdtempSync(path.join(root,"sealed-"));
        fs.copyFileSync(path.join(owner.descriptor.directory,"dist",name),path.join(independent,name));
        assert.equal(await runManagedCommand({
          bin:process.execPath,args:[path.join(independent,name)],cwd:independent,
          env:process.env,timeoutMs:10000,requireProcessTreeExit:process.platform !== "win32",
        }),0);
        assert.deepEqual(fs.readdirSync(independent),[name]);
      }
      const relativeInputs = Object.keys(manifest.inputs).map(name => path.relative(root,name));
      assert.ok(relativeInputs.every(name => !path.isAbsolute(name) && name !== ".." && !name.startsWith(".." + path.sep)));
      assert.ok(manifest.inputs[path.join(root,"scripts/lib/vitest-worker-declarations.mts")]);
      receipt = {directory:owner.descriptor.directory,inputs:Object.keys(manifest.inputs),outputs:Object.keys(manifest.outputs),durationMs:manifest.durationMs};
    } catch (error) {failure = {error};}
    try {await owner.dispose();}
    catch (error) {
      if (failure) {throw new AggregateError([failure.error,error],"Fixture run and disposal failed",{cause:error});}
      throw error;
    }
    if (failure) {throw failure.error;}
    assert.equal(fs.existsSync(owner.descriptor.directory),false);
    fs.appendFileSync(path.join(root,"owners.jsonl"),JSON.stringify(receipt)+"\\n");
    `,
  );
  assertImplementationCopies();
  return {
    config,
    value,
    configuredValue,
    parent,
    cacheDirectory,
    driver,
    implementationHashes,
    assertImplementationCopies,
  };
}
