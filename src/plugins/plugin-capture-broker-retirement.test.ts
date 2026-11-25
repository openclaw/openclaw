import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = createTempDirTracker();
const capturedSource = "module.exports = 'captured';\n";
const preparation = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.snapshotPreparation);
const lifecycle = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.nativeLifecycle);

afterEach(() => temp.cleanup());

it("reuses the broker for successive captures and joins it after idle", async () => {
  const root = temp.make("plugin-broker-retirement-");
  const source = path.join(root, "plugin");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "index.cjs"), capturedSource);
  const script = `
    import assert from "node:assert/strict";
    import childProcess from "node:child_process";
    import { once } from "node:events";
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const idleTimers = new Map();
    const schedule = globalThis.setTimeout;
    const cancel = globalThis.clearTimeout;
    globalThis.setTimeout = (callback, delay, ...args) => {
      const timer = schedule(callback, delay, ...args);
      if (callback.name === "retireNativeBrokerAfterIdle") idleTimers.set(timer, callback);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      idleTimers.delete(timer);
      cancel(timer);
    };
    const children = [];
    const spawn = childProcess.spawn;
    childProcess.spawn = (...args) => {
      const child = spawn(...args);
      if (args[1]?.some((arg) => arg.includes("spawn-broker") && arg.includes("worker."))) {
        children.push(child);
      }
      return child;
    };
    syncBuiltinESMExports();
    const { preparePluginGenerationArtifact } = await import(${JSON.stringify(preparation.href)});
    const { closeDefaultRetainedNativeWorkerSource } = await import(${JSON.stringify(lifecycle.href)});
    const rootDir = process.argv[1];
    const source = path.join(rootDir, "index.cjs");
    const prepare = () => preparePluginGenerationArtifact({ rootDir, source });
    try {
      const first = await prepare();
      const sibling = await prepare();
      assert.equal(children.length, 1);
      const broker = children[0];
      assert.equal(fs.readFileSync(first.artifact.resolve(source), "utf8"), ${JSON.stringify(capturedSource)});
      await first.artifact.disposeAsync();
      assert.equal(broker.exitCode, null, "the sibling still owns its capture");
      assert.equal(idleTimers.size, 0);
      await sibling.artifact.disposeAsync();
      assert.equal(idleTimers.size, 1, "last release schedules retirement");
      const warm = await prepare();
      assert.equal(children.length, 1, "reuse the broker during the idle window");
      assert.equal(idleTimers.size, 0, "new custody cancels retirement");
      await warm.artifact.disposeAsync();
      assert.equal(idleTimers.size, 1);
      const [timer, retire] = idleTimers.entries().next().value;
      globalThis.clearTimeout(timer);
      const exited = once(broker, "exit");
      retire();
      assert.deepEqual(await exited, [0, null]);
      const next = await prepare();
      assert.equal(children.length, 2, "a later capture starts a fresh broker");
      assert.equal(fs.readFileSync(next.artifact.resolve(source), "utf8"), ${JSON.stringify(capturedSource)});
      await next.artifact.disposeAsync();
    } finally {
      await closeDefaultRetainedNativeWorkerSource();
    }
  `;
  const result = await runNodeScript(
    (workerArgv) => [
      ...workerArgv(preparation).slice(0, -1),
      "--input-type=module",
      "-e",
      script,
      source,
    ],
    {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      TMPDIR: root,
      TMP: root,
      TEMP: root,
    },
    25_000,
    { executable: process.execPath, requireProcessTreeExit: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
}, 30_000);
