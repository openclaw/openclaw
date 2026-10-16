import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerThreadExecArgv } from "../infra/runtime-worker-url.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("cleans up rejected native ESM acquisitions and failed compiled evaluations", async () => {
  const root = temp.make("plugin-native-failed-acquisition-");
  const captures = temp.make("plugin-native-failed-captures-");
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(root, "index.mjs"),
    'export const marker = "loaded"; export const read = () => import("./side.mjs");',
  );
  fs.writeFileSync(path.join(root, "side.mjs"), 'export const value = "side";');
  fs.writeFileSync(path.join(root, "broken.mjs"), 'import "./broken.ts";');
  fs.writeFileSync(
    path.join(root, "broken.ts"),
    'export const value: number = 1; throw new Error("broken plugin helper");',
  );
  const moduleUrl = (name: string) => new URL(name, import.meta.url).href;
  const source = `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import { pathToFileURL } from "node:url";
      import { parentPort } from "node:worker_threads";
      import { createPluginCache, withPluginCache } from ${JSON.stringify(moduleUrl("./plugin-cache.ts"))};
      import { bindPluginInstanceModuleLoader } from ${JSON.stringify(moduleUrl("./plugin-instance-module-loader.ts"))};
      import { PluginInstance } from ${JSON.stringify(moduleUrl("./plugin-instance.ts"))};
      import { withPluginSourceCaptureDirectory } from ${JSON.stringify(moduleUrl("./plugin-package-metadata-capture.ts"))};
      const failed = new PluginInstance("failed-acquisition");
      const loaded = new PluginInstance("loaded-acquisition");
      const broken = new PluginInstance("failed-evaluation");
      const cache = createPluginCache();
      const rootDir = ${JSON.stringify(root)};
      const source = ${JSON.stringify(path.join(root, "index.mjs"))};
      const side = new URL("./side.mjs", pathToFileURL(source)).href;
      const captures = ${JSON.stringify(captures)};
      const bind = (instance, expectedSourceDigest, entry = source) => withPluginCache(cache, () =>
        bindPluginInstanceModuleLoader({ instance, origin: "config", rootDir, source: entry, expectedSourceDigest }));
      try {
        await withPluginSourceCaptureDirectory(captures, async () => {
          assert.throws(() => bind(failed, "0".repeat(64)), /source changed after installation/);
          assert.deepEqual(fs.readdirSync(captures), []);
          bind(loaded);
          assert.equal(loaded.loadModule(source).marker, "loaded");
          // The failed acquisition must not borrow the successful owner's lazy resolver.
          await assert.rejects(failed.run(() => import(side)), /no live workspace owner/);
          await failed.dispose();
          assert.equal((await loaded.loadModule(source).read()).value, "side");
          const brokenSource = ${JSON.stringify(path.join(root, "broken.mjs"))};
          bind(broken, undefined, brokenSource);
          assert.throws(() => broken.loadModule(brokenSource), /broken plugin helper/);
          await broken.dispose();
          // Failed evaluations must release compiler state, not just their capture files.
          const retained = globalThis[Symbol.for("openclaw.retainedNativeEsmPluginModules")];
          assert.equal([...retained.values()].filter(state => !state.loaded)
            .reduce((count, state) => count + state.builds.size, 0), 0);
        });
        parentPort.postMessage("acquired after rejection");
      } finally {
        await failed.dispose();
        await loaded.dispose();
        await broken.dispose();
      }
    `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
    execArgv: resolveRuntimeWorkerThreadExecArgv(
      new URL("./plugin-instance-module-loader.ts", import.meta.url),
    ),
    workerData: { sourceCaptureDirectory: captures },
  });
  try {
    const [result] = await once(worker, "message");
    expect(result).toBe("acquired after rejection");
  } finally {
    await worker.terminate();
  }
});
