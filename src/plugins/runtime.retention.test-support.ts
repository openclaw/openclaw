import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setImmediate as scheduleImmediate } from "node:timers";
import { setImmediate } from "node:timers/promises";
import { hasInternalDiagnosticEventListeners } from "../infra/diagnostic-event-listener-presence.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
} from "../plugin-sdk/diagnostic-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createPluginCache,
  getPluginCache,
  getPluginCacheRetirementSignal,
  retirePluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { PluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";
import { disposePluginRegistryInstances, waitForPluginRegistryRetirement } from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

const emptyResult = { cleanupCount: 0, failures: [] };

function assertCollected(reference: WeakRef<object>, message: string) {
  assert.equal(reference.deref(), undefined, message);
}

function withFixtureEnvironment<T>(root: string, run: () => Promise<T>) {
  return withEnvAsync(
    {
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    },
    run,
  );
}

function writeManifest(root: string, additionalProperties?: false) {
  fs.writeFileSync(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id: "retention-fixture",
      configSchema: {
        type: "object",
        ...(additionalProperties === false ? { additionalProperties } : {}),
      },
      contracts: { tools: ["retention_fixture"] },
    }),
  );
}

function fixtureConfig(entry: string) {
  return {
    plugins: {
      allow: ["retention-fixture"],
      load: { paths: [entry] },
      slots: { memory: "none" },
    },
  };
}

function loadFixture(
  loadOpenClawPlugins: (typeof import("./loader.js"))["loadOpenClawPlugins"],
  entry: string,
  previousRegistry?: ReturnType<typeof createEmptyPluginRegistry>,
) {
  const cache = createPluginCache();
  const registry = withPluginCache(cache, () =>
    loadOpenClawPlugins({
      config: fixtureConfig(entry),
      pluginSdkResolution: "src",
      activate: false,
      cache: false,
      previousRegistry,
    }),
  );
  assert.deepEqual(
    registry.plugins.map((record) => record.status),
    ["loaded"],
    JSON.stringify(registry.diagnostics),
  );
  return { registry, cache };
}

async function collect(...released: WeakRef<object>[]) {
  const gc = globalThis.gc;
  assert.ok(gc, "The retention child requires --expose-gc");
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    // JavaScriptCore's promise-microtask stack can retain completed async values.
    await new Promise<void>((resolve) => {
      scheduleImmediate(() => {
        gc();
        resolve();
      });
    });
  }
  // JavaScriptCore also scans native stacks conservatively. Bun's immediate
  // dispatcher can keep a stale pointer to a completed fixture graph across
  // every immediate; a timer-phase collection runs from other native frames.
  // These passes are bounded and do not delay a graph that already collected.
  for (
    let pass = 0;
    pass < 4 && released.some((reference) => reference.deref() !== undefined);
    pass += 1
  ) {
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        gc();
        resolve();
      }, 0);
    });
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
}

function createRetirementRegistry(withInstance: boolean) {
  const registry = createEmptyPluginRegistry();
  if (withInstance) {
    const record = createPluginRecord({ id: "retirement-source" });
    registry.plugins.push(record);
    void new PluginInstance(record.id, { record, registry });
  }
  return registry;
}

async function retireSuccessors(withInstance: boolean) {
  const oldest = createRetirementRegistry(withInstance);
  const successors: WeakRef<ReturnType<typeof createEmptyPluginRegistry>>[] = [];
  let previous = oldest;
  for (let generation = 0; generation < 3; generation += 1) {
    const next = createRetirementRegistry(withInstance);
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

function inspectAfterFrameRelease<T>(
  produce: () => Promise<T>,
  inspect: (result: T) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    void produce().then((result) => {
      // Inspect inside the next task so no producer or outer resolution frame stays live.
      void setImmediate().then(() => inspect(result).then(resolve, reject), reject);
    }, reject);
  });
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

function createInspectionRetirement(
  failure: "none" | "completed" | "retained" | "rollback-retained",
) {
  const cache = createPluginCache();
  const registry = createEmptyPluginRegistry();
  const cleanupCapture = { label: "registration cleanup" };
  const entered = createDeferredCore();
  const finish = createDeferredCore();
  const resources = new PluginRegistryInspectionResources(async () => {
    entered.resolve();
    await finish.promise;
    await retirePluginCache(cache);
    if (failure === "retained") {
      throw new PluginRuntimeCloseRetainedError(new Error("Unfinished disposal"));
    }
    if (failure === "completed") {
      throw new Error("Completed disposal callback failed");
    }
  });
  resources.attach(registry);
  resources.runRegistration(
    "fixture",
    () => {},
    async (run) => {
      assert.equal(cleanupCapture.label, "registration cleanup");
      await run();
    },
  );
  if (failure === "rollback-retained") {
    resources.rollback("fixture", async () => {
      throw new PluginRuntimeCloseRetainedError(new Error("Unfinished rollback"));
    });
  }
  return {
    resources,
    borrowed: resources.retain(),
    entered,
    finish,
    references: [cache, registry, cleanupCapture].map((value) => new WeakRef(value)),
  };
}

async function loadReplacement(root: string) {
  const { loadOpenClawPlugins } = await import("./loader.js");
  const previous = createEmptyPluginRegistry();
  const reference = new WeakRef(previous);
  const { registry, cache } = loadFixture(
    loadOpenClawPlugins,
    path.join(root, "index.cjs"),
    previous,
  );
  assert.deepEqual(
    await disposePluginRegistryInstances(previous, registry, { cfg: {} }),
    emptyResult,
  );
  assert.deepEqual(await waitForPluginRegistryRetirement(previous), emptyResult);
  return { registry, cache, reference };
}

async function reloadDiagnosticSubscribers(root: string) {
  const { loadOpenClawPlugins } = await import("./loader.js");
  const retired: WeakRef<object>[] = [];
  let current: Awaited<ReturnType<typeof load>> | undefined;
  async function load() {
    const { registry, cache } = loadFixture(loadOpenClawPlugins, root);
    const tool = registry.tools[0]?.factory({ config: {} });
    assert.ok(tool && !Array.isArray(tool));
    const result = await tool.execute("inspect", {});
    assert.ok(result.details && typeof result.details === "object");
    const instance = getPluginInstance(registry.plugins[0]!);
    assert.ok(instance);
    return { cache, registry, evidence: result.details, instance };
  }
  for (let generation = 0; generation < 4; generation++) {
    if (current) {
      retired.push(new WeakRef(current.evidence), new WeakRef(current.instance));
      await disposePluginRegistryInstances(current.registry, undefined, { cfg: {} });
      await retirePluginCache(current.cache);
      assert.equal(
        hasInternalDiagnosticEventListeners(),
        false,
        "Retired listeners must be removed",
      );
    }
    current = await load();
    assert.equal(hasInternalDiagnosticEventListeners(), true);
    emitDiagnosticEvent({ type: "message.queued", source: "retention-fixture" });
    assert.deepEqual(current.evidence, { events: 2 });
  }
  assert.ok(current);
  return { current, retired };
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
  await recovery.dispose();
  return { current, source, owner, registry };
}

switch (process.argv[2]) {
  case "inspection": {
    const generations = Array.from({ length: 3 }, () => createInspectionRetirement("none"));
    generations.push(createInspectionRetirement("completed"));
    const retained = [
      createInspectionRetirement("retained"),
      createInspectionRetirement("rollback-retained"),
    ];
    for (const generation of [...generations, ...retained]) {
      await generation.resources.release().catch(() => {});
      const value = {};
      assert.equal(generation.resources.wrapAdoptedValue(value), value);
      await collect();
      assert.ok(
        generation.references.every((reference) => reference.deref() !== undefined),
        "Logical release must preserve borrowed inspection resources",
      );
      const release = generation.borrowed.release();
      const outcome = release.catch((error: unknown) => error);
      await generation.entered.promise;
      await collect();
      assert.ok(
        generation.references.every((reference) => reference.deref() !== undefined),
        "Pending physical disposal must preserve inspection resources",
      );
      generation.finish.resolve();
      await outcome;
      assert.equal(generation.borrowed.release(), release);
    }
    await collect(...generations.flatMap(({ references }) => references));
    for (const [index, generation] of generations.entries()) {
      assert.throws(() => generation.resources.wrapAdoptedValue({}), /have been released/);
      for (const [field, reference] of generation.references.entries()) {
        assert.ok(!reference.deref(), `Released inspection ${index} retained resource ${field}`);
      }
      await generation.resources.release();
    }
    for (const generation of retained) {
      assert.ok(
        generation.references.every((reference) => reference.deref() !== undefined),
        "Incomplete disposal must preserve retained custody",
      );
    }
    break;
  }
  case "diagnostics": {
    // openclaw-temp-dir: allow -- standalone GC child joins registry cleanup below.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "diagnostic-retention-")));
    const sdkKey = Symbol.for("openclaw.test.diagnostic-retention-sdk");
    // The compiled GC child supplies its real SDK exports without resolving source .ts modules.
    Reflect.set(globalThis, sdkKey, { onDiagnosticEvent, onInternalDiagnosticEvent });
    try {
      writeManifest(root);
      fs.writeFileSync(
        path.join(root, "index.cjs"),
        `
        const { onDiagnosticEvent, onInternalDiagnosticEvent } = globalThis[Symbol.for("openclaw.test.diagnostic-retention-sdk")];
        const evidence = { events: 0 };
        onDiagnosticEvent(() => evidence.events++);
        module.exports = { id: "retention-fixture", register(api) {
          onInternalDiagnosticEvent(() => evidence.events++);
          api.registerTool({ name: "retention_fixture", label: "Fixture", description: "Inspect evidence",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [], details: evidence }) });
        } };
      `,
      );
      await withFixtureEnvironment(root, () =>
        inspectAfterFrameRelease(
          () => reloadDiagnosticSubscribers(root),
          async ({ current, retired }) => {
            try {
              await collect();
              assert.equal(
                retired.filter((reference) => reference.deref() !== undefined).length,
                0,
                "Old evidence and plugin instances must collect",
              );
              emitDiagnosticEvent({ type: "message.queued", source: "retention-fixture" });
              assert.deepEqual(current.evidence, { events: 4 });
            } finally {
              await disposePluginRegistryInstances(current.registry, undefined, { cfg: {} });
              await retirePluginCache(current.cache);
            }
            assert.equal(hasInternalDiagnosticEventListeners(), false);
          },
        ),
      );
    } finally {
      Reflect.deleteProperty(globalThis, sdkKey);
      fs.rmSync(root, { recursive: true, force: true });
    }
    break;
  }
  case "recovery-source":
  case "recovery-bundled-cjs":
  case "recovery-bundled-mjs": {
    const kind = process.argv[2].slice("recovery-".length);
    assert.ok(kind === "source" || kind === "bundled-cjs" || kind === "bundled-mjs");
    // openclaw-temp-dir: allow -- standalone GC child has no Vitest hooks and joins cleanup below.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "recovery-retention-")));
    await inspectAfterFrameRelease(
      () => recoverOwner(root, kind),
      async (result) => {
        try {
          await collect(result.owner, result.registry);
          assertCollected(result.owner, "Live recovery retained its retired instance");
          assertCollected(result.registry, "Live recovery retained its retired registry");
          assert.equal(
            (result.current.loadModule(result.source) as { read(): string }).read(),
            "recovered source",
          );
        } finally {
          await result.current.dispose();
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
    );
    break;
  }
  case "inspection-loader":
  case "loader": {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-retention-")));
    const captureKey = Symbol.for("openclaw.test.inspection-retention");
    try {
      writeManifest(root, false);
      fs.writeFileSync(
        path.join(root, "index.cjs"),
        `module.exports = {
        id: "retention-fixture",
        register(api) {
          globalThis[Symbol.for("openclaw.test.inspection-retention")]?.();
          api.registerTool({ name: "retention_fixture", label: "Retention fixture", description: "Returns a marker",
            parameters: { type: "object", properties: {} },
            execute: async () => ({ content: [{ type: "text", text: "current generation" }] }) });
        }
      };`,
      );
      await withFixtureEnvironment(root, async () => {
        if (process.argv[2] === "inspection-loader") {
          const { acquirePluginRegistryForInspection } = await import("./loader.js");
          const references: WeakRef<object>[] = [];
          Reflect.set(globalThis, captureKey, () => references.push(new WeakRef(getPluginCache())));
          const handles = [];
          for (let generation = 0; generation < 3; generation++) {
            const handle = await acquirePluginRegistryForInspection({
              config: fixtureConfig(root),
              pluginSdkResolution: "src",
              throwOnLoadError: true,
            });
            assert.equal(handle.registry.plugins[0]?.status, "loaded");
            handles.push(handle);
            await handle.release();
          }
          assert.equal(references.length, 3);
          await collect(...references);
          for (const reference of references) {
            assert.ok(!reference.deref(), "Public inspection handle retained its retired cache");
          }
          for (const handle of handles) {
            await handle.release();
          }
          return;
        }
        const { registry, cache, reference } = await loadReplacement(root);
        try {
          await collect();
          assertCollected(reference, "Live replacement retained its predecessor registry");
          const tool = registry.tools[0]?.factory({ config: {} });
          assert.ok(tool && !Array.isArray(tool));
          assert.deepEqual(await tool.execute("retention-call", {}), {
            content: [{ type: "text", text: "current generation" }],
          });
        } finally {
          await disposePluginRegistryInstances(registry, undefined, { cfg: {} });
          await retirePluginCache(cache);
        }
      });
    } finally {
      Reflect.deleteProperty(globalThis, captureKey);
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
    assertCollected(reference, "Disposed instance retained its source lookup");
    assert.equal(instance.hasModuleSource("captured-source"), false);
    assert.throws(() => instance.loadModule("captured-source"), /reloaded or disabled/);
    const neverBound = new PluginInstance("never-bound");
    await neverBound.dispose();
    assert.equal(neverBound.hasModuleSource("library"), undefined);
    break;
  }
  case "registry":
  case "registry-instances": {
    await inspectAfterFrameRelease(
      () => retireSuccessors(process.argv[2] === "registry-instances"),
      async ({ oldest, successors }) => {
        await collect();
        assert.ok(
          successors.every((reference) => reference.deref() === undefined),
          "Completed retirement retained a successor registry",
        );
        assert.deepEqual(await waitForPluginRegistryRetirement(oldest), emptyResult);
        assert.deepEqual(await disposePluginRegistryInstances(oldest), emptyResult);
      },
    );
    break;
  }
  case "cache": {
    await inspectAfterFrameRelease(retireCapturedCallback, async ({ cache, signal, reference }) => {
      await collect();
      assertCollected(reference, "Retired cache retained its callback capture");
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
    });
    break;
  }
  default:
    throw new Error("Expected registry, cache, instance, or formatter retention scenario");
}
