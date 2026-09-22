import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createPluginCache,
  getPluginCacheRetirementSignal,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { disposePluginRegistryInstances, waitForPluginRegistryRetirement } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

const emptyResult = { cleanupCount: 0, failures: [] };

async function collect() {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
}

async function retireSuccessors() {
  const oldest = createEmptyPluginRegistry();
  const successors: WeakRef<ReturnType<typeof createEmptyPluginRegistry>>[] = [];
  let previous = oldest;
  for (let generation = 0; generation < 3; generation += 1) {
    const next = createEmptyPluginRegistry();
    successors.push(new WeakRef(next));
    assert.deepEqual(
      await disposePluginRegistryInstances(previous, next, { cfg: {} }),
      emptyResult,
    );
    assert.deepEqual(await waitForPluginRegistryRetirement(previous), emptyResult);
    previous = next;
  }
  return { oldest, successors };
}

async function retireCapturedCallback() {
  const marker = { label: "startup-only retirement capture" };
  const reference = new WeakRef(marker);
  const cache = createPluginCache();
  const signal = getPluginCacheRetirementSignal(cache);
  let calls = 0;
  const beforeRetire = () => {
    assert.equal(marker.label, "startup-only retirement capture");
    calls += 1;
  };
  // Match a lifecycle caller whose stack frame closes over the retirement callback.
  const retire = () => retirePluginCache(cache, beforeRetire);
  assert.deepEqual(await retire(), emptyResult);
  assert.equal(calls, 1);
  return { cache, signal, reference };
}

async function retireCapturedSource() {
  const instance = new PluginInstance("source-retention");
  const source = { path: "captured-source" };
  const reference = new WeakRef(source);
  instance.bindModuleLoader(
    () => 42,
    (modulePath) => modulePath === source.path,
  );
  assert.equal(instance.hasModuleSource(source.path), true);
  assert.equal(instance.loadModule(source.path), 42);
  await instance.dispose();
  return { instance, reference };
}

async function loadReplacement(root: string) {
  const { loadOpenClawPlugins } = await import("./loader.js");
  const previous = createEmptyPluginRegistry();
  const reference = new WeakRef(previous);
  const cache = createPluginCache();
  const registry = withPluginCache(cache, () =>
    loadOpenClawPlugins({
      config: {
        plugins: {
          allow: ["retention-fixture"],
          load: { paths: [path.join(root, "index.cjs")] },
          slots: { memory: "none" },
        },
      },
      pluginSdkResolution: "src",
      activate: false,
      cache: false,
      previousRegistry: previous,
    }),
  );
  assert.deepEqual(
    registry.plugins.map((record) => record.status),
    ["loaded"],
  );
  assert.deepEqual(
    await disposePluginRegistryInstances(previous, registry, { cfg: {} }),
    emptyResult,
  );
  assert.deepEqual(await waitForPluginRegistryRetirement(previous), emptyResult);
  return { registry, cache, reference };
}

async function recoverOwner(root: string, kind: "source" | "bundled-cjs" | "bundled-mjs") {
  const extension = kind === "bundled-mjs" ? "mjs" : "cjs";
  const source = path.join(root, `index.${extension}`);
  fs.writeFileSync(
    source,
    `${extension === "mjs" ? "export const read =" : "exports.read ="} () => 'recovered source';`,
  );
  if (kind === "bundled-mjs") {
    // Native ESM's first module job retains its caller even without recovery.
    // Warm outside admission to isolate recovery custody from that existing leak;
    // cold module evaluation remains covered by the functional recovery tests.
    createRequire(import.meta.url)(source);
  }
  const previous = createEmptyPluginRegistry();
  const record = createPluginRecord({ id: "recovery-retention", rootDir: root, source });
  previous.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: previous });
  const owner = new WeakRef(instance);
  const registry = new WeakRef(previous);
  bindPluginInstanceModuleLoader({
    instance,
    origin: kind === "source" ? "config" : "bundled",
    source,
    rootDir: root,
  });
  assert.equal((instance.loadModule(source) as { read(): string }).read(), "recovered source");
  const recovery = instance.captureModuleLoaderRecovery();
  await instance.dispose();
  const current = new PluginInstance(record.id);
  recovery.bind(current);
  recovery.dispose();
  return { current, source, owner, registry };
}

switch (process.argv[2]) {
  case "recovery-source":
  case "recovery-bundled-cjs":
  case "recovery-bundled-mjs": {
    const kind = process.argv[2].slice("recovery-".length);
    assert.ok(kind === "source" || kind === "bundled-cjs" || kind === "bundled-mjs");
    // openclaw-temp-dir: allow -- standalone GC child has no Vitest hooks and joins cleanup below.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recovery-retention-")));
    const result = await recoverOwner(root, kind);
    try {
      await collect();
      assert.equal(result.owner.deref(), undefined, "Live recovery retained its retired instance");
      assert.equal(
        result.registry.deref(),
        undefined,
        "Live recovery retained its retired registry",
      );
      assert.equal(
        (result.current.loadModule(result.source) as { read(): string }).read(),
        "recovered source",
      );
      // Keep the recovery factory live too: another failed update must still be recoverable.
      const recovery = result.current.captureModuleLoaderRecovery();
      recovery.dispose();
    } finally {
      await result.current.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
    break;
  }
  case "loader": {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-retention-")));
    try {
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: "retention-fixture",
          configSchema: { type: "object", additionalProperties: false },
          contracts: { tools: ["retention_fixture"] },
        }),
      );
      fs.writeFileSync(
        path.join(root, "index.cjs"),
        `module.exports = {
        id: "retention-fixture",
        register(api) {
          api.registerTool({ name: "retention_fixture", label: "Retention fixture", description: "Returns a marker",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [{ type: "text", text: "current generation" }] }) });
        }
      };`,
      );
      await withEnvAsync(
        {
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        },
        async () => {
          const { registry, cache, reference } = await loadReplacement(root);
          try {
            await collect();
            assert.equal(
              reference.deref(),
              undefined,
              "Live replacement retained its predecessor registry",
            );
            const tool = registry.tools[0]?.factory({ config: {} });
            assert.ok(tool && !Array.isArray(tool));
            assert.deepEqual(await tool.execute("retention-call", {}), {
              content: [{ type: "text", text: "current generation" }],
            });
          } finally {
            await disposePluginRegistryInstances(registry, undefined, { cfg: {} });
            await retirePluginCache(cache);
          }
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    break;
  }
  case "formatter": {
    const cache = createPluginCache();
    const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    const failure = new Error("synthetic stack formatter failure");
    let calls = 0;
    try {
      Error.prepareStackTrace = () => {
        throw failure;
      };
      assert.deepEqual(await retirePluginCache(cache, () => calls++), emptyResult);
    } finally {
      if (formatter) {
        Object.defineProperty(Error, "prepareStackTrace", formatter);
      } else {
        Reflect.deleteProperty(Error, "prepareStackTrace");
      }
    }
    assert.equal(calls, 1);
    assert.equal(getPluginCacheRetirementSignal(cache).aborted, true);
    break;
  }
  case "instance": {
    const { instance, reference } = await retireCapturedSource();
    await collect();
    assert.equal(reference.deref(), undefined, "Disposed instance retained its source lookup");
    assert.equal(instance.hasModuleSource("captured-source"), false);
    assert.throws(() => instance.loadModule("captured-source"), /reloaded or disabled/);
    const neverBound = new PluginInstance("never-bound");
    await neverBound.dispose();
    assert.equal(neverBound.hasModuleSource("library"), undefined);
    break;
  }
  case "registry": {
    const { oldest, successors } = await retireSuccessors();
    await collect();
    assert.ok(
      successors.every((reference) => reference.deref() === undefined),
      "Completed retirement retained a successor registry",
    );
    assert.deepEqual(await waitForPluginRegistryRetirement(oldest), emptyResult);
    assert.deepEqual(await disposePluginRegistryInstances(oldest), emptyResult);
    break;
  }
  case "cache": {
    const { cache, signal, reference } = await retireCapturedCallback();
    await collect();
    assert.equal(reference.deref(), undefined, "Retired cache retained its callback capture");
    assert.equal(getPluginCacheRetirementSignal(cache), signal);
    assert.equal(signal.aborted, true);
    const reason: unknown = signal.reason;
    const defaultReason: unknown = AbortSignal.abort().reason;
    assert.ok(reason instanceof DOMException);
    assert.ok(defaultReason instanceof DOMException);
    assert.equal(reason.name, defaultReason.name);
    assert.equal(reason.code, defaultReason.code);
    assert.equal(reason.message, defaultReason.message);
    assert.equal(typeof reason.stack, "string");
    assert.throws(
      () => signal.throwIfAborted(),
      (error) => error === reason,
    );
    assert.deepEqual(await retirePluginCache(cache), emptyResult);
    const other = createPluginCache();
    await retirePluginCache(other);
    assert.notEqual(getPluginCacheRetirementSignal(other).reason, reason);
    break;
  }
  default:
    throw new Error("Expected registry, cache, instance, or formatter retention scenario");
}
