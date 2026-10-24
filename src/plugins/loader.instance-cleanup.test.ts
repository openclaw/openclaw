import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closePreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.lifecycle.js";
import { ownPreparedPluginGeneration } from "../agents/prepared-model-runtime.plugin-lifetime.js";
import { collectErrorGraphCandidates } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  acquirePluginRegistryForInspection,
  clearPluginRegistryLoadCache,
  loadOpenClawPlugins,
} from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { createInspectionFixture } from "./registry-inspection.test-helpers.js";
import { hasRetainedPluginRuntimeCloseError } from "./runtime-close-error.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";

function writeToolPlugin(params: Parameters<typeof writePlugin>[0] & { tool: string }) {
  const { tool, ...definition } = params;
  const plugin = writePlugin(definition);
  writeFileSync(
    path.join(plugin.dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: plugin.id,
      configSchema: { type: "object", properties: {} },
      contracts: { tools: [tool] },
    }),
  );
  return plugin;
}

function writeResourceTool(params: { id: string; setup: string; cleanup: string; value: string }) {
  const { id, setup, cleanup, value } = params;
  return writeToolPlugin({
    id,
    tool: "probe",
    body: `${setup}
    module.exports = { id: ${JSON.stringify(id)}, register(api) {
      api.lifecycle.onDispose(() => { ${cleanup} });
      api.registerTool({ name: "probe", description: "Read a captured resource",
        parameters: { type: "object", properties: {} },
        async execute() { return { content: [{ type: "text", text: ${value} }] }; }
      });
    } };`,
  });
}

function toolFor(registry: ReturnType<typeof loadOpenClawPlugins>) {
  const tool = registry.tools[0]?.factory({});
  if (!tool || Array.isArray(tool)) {
    throw new Error("Expected a registered resource probe");
  }
  return tool;
}

async function expectToolText(tool: ReturnType<typeof toolFor>, call: string, text: string) {
  await expect(tool.execute(call, {})).resolves.toMatchObject({
    content: [{ type: "text", text }],
  });
}

function pluginConfig(...plugins: ReturnType<typeof writePlugin>[]) {
  return {
    plugins: {
      allow: plugins.map((plugin) => plugin.id),
      load: { paths: plugins.map((plugin) => plugin.file) },
      slots: { memory: "none" },
    },
  };
}

afterEach(resetPluginLoaderTestStateForTest);
beforeEach(useNoBundledPlugins);

function loadPlugins(
  plugins: ReturnType<typeof writePlugin>[],
  options: Omit<Parameters<typeof loadOpenClawPlugins>[0], "config"> = {},
) {
  return loadOpenClawPlugins({
    config: pluginConfig(...plugins),
    cache: false,
    activate: false,
    ...options,
  });
}

function loaded(
  plugin: ReturnType<typeof writePlugin>,
  overrides: Omit<Parameters<typeof loadOpenClawPlugins>[0], "config"> = {},
) {
  const cache = createPluginCache();
  const options = { config: pluginConfig(plugin), cache: false, activate: false, ...overrides };
  const reload = () => withPluginCache(cache, () => loadOpenClawPlugins(options));
  const registry = reload();
  return {
    cache,
    registry,
    reload,
    async [Symbol.asyncDispose]() {
      await disposePluginRegistryInstances(registry);
      await retirePluginCache(cache);
    },
  };
}

function eventProbe(event: string) {
  const original = process.listeners(event);
  return {
    count: () => process.listenerCount(event) - original.length,
    [Symbol.dispose]() {
      for (const listener of process.listeners(event)) {
        if (!original.includes(listener)) {
          process.off(event, listener);
        }
      }
    },
  };
}

async function inspect() {
  const fixture = createInspectionFixture();
  const inspection = await acquirePluginRegistryForInspection({ config: fixture.config });
  const instance = getPluginInstance(inspection.registry.plugins[0]!);
  if (!instance) {
    throw new Error("Missing inspection instance");
  }
  return { fixture, inspection, instance };
}

function observeSettlement(promise: Promise<unknown>, done: () => void) {
  void promise.then(done, done);
}

it.each(["settled", "rejected"] as const)(
  "reports %s inspection disposal without confusing failure with retained custody",
  async (outcome) => {
    const { fixture, inspection, instance } = await inspect();
    const failure = new Error("fixture instance disposal failed");
    const dispose = vi.fn(() => {
      if (outcome === "settled") {
        throw failure;
      }
    });
    instance.lifecycle.onDispose(dispose);
    const observedDispose = outcome === "settled" ? undefined : vi.spyOn(instance, "dispose");
    if (outcome === "rejected") {
      observedDispose?.mockRejectedValue(failure);
    }
    try {
      const release = inspection.release();
      const error: unknown = await release.catch((reason: unknown) => reason);
      expect(
        collectErrorGraphCandidates(error, (candidate) => [
          candidate.cause,
          ...(Array.isArray(candidate.errors) ? candidate.errors : []),
        ]),
      ).toContain(failure);
      expect(hasRetainedPluginRuntimeCloseError(error)).toBe(outcome !== "settled");
      expect(inspection.release()).toBe(release);
      expect(instance.acceptingCalls).toBe(false);
      expect(fixture.connection().database.isOpen).toBe(false);
      if (outcome === "settled") {
        expect(dispose).toHaveBeenCalledOnce();
        expect(fixture.connection().instanceDisposals).toBe(1);
      }
    } finally {
      observedDispose?.mockRestore();
      await instance.dispose();
      await fixture.cleanup(inspection);
    }
  },
);

it.each([false, true])(
  "closes after forced retirement settles (cleanup failure: %s)",
  async (failCleanup) => {
    const { fixture, inspection, instance } = await inspect();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    instance.lifecycle.onDispose(async () => {
      entered.resolve();
      await finish.promise;
      if (failCleanup) {
        throw new Error("late fixture cleanup failed");
      }
    });
    const generation = ownPreparedPluginGeneration({
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture(),
      pluginRegistry: inspection.registry,
      remoteCatalog: null,
      inlineProviderModels: [],
      configuredCatalogEntries: [],
    });
    await inspection.release();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const retirement = generation.close();
    void retirement.catch(() => {});
    let closing: Promise<void> | undefined;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await instance.dispose()).errors).toMatchObject([
        { forcedRetirement: { activeCallCount: 1 } },
      ]);
      let completed = false;
      closing = closePreparedModelRuntimeSnapshots();
      observeSettlement(closing, () => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect.soft(completed).toBe(false);
      finish.resolve();
      await expect(closing).resolves.toBeUndefined();
      await expect(closePreparedModelRuntimeSnapshots()).resolves.toBeUndefined();
      expect(fixture.connection().instanceDisposals).toBe(1);
    } finally {
      finish.resolve();
      await Promise.allSettled([retirement, closing]);
      vi.useRealTimers();
      await fixture.cleanup(inspection);
    }
  },
);

it.each([true, false])(
  "keeps workflow admission through registration and retirement (activate: %s)",
  async (activate) => {
    const id = `registration-workflow-${activate}`;
    const observationFile = path.join(makePluginLoaderTempDir(), "observed.json");
    const plugin = writeToolPlugin({
      id,
      tool: "workflow_probe",
      body: `const fs = require("node:fs");
        module.exports = { id: ${JSON.stringify(id)}, register(api) {
          const observe = (phase) => {
            const set = api.runContext.setRunContext({ runId: "fixture-run", namespace: "startup", value: { phase } });
            const value = api.runContext.getRunContext({ runId: "fixture-run", namespace: "startup" });
            const event = api.agent.events.emitAgentEvent({ runId: "fixture-run", stream: ${JSON.stringify(`${id}.startup`)}, data: { phase } });
            api.runContext.clearRunContext({ runId: "fixture-run", namespace: "startup" });
            const cleared = api.runContext.getRunContext({ runId: "fixture-run", namespace: "startup" }) === undefined;
            fs.writeFileSync(${JSON.stringify(observationFile)}, JSON.stringify({ phase, set, value, event, cleared }));
          };
          observe("register");
          api.registerTool(() => { observe("callback"); return null; }, { names: ["workflow_probe"] });
        } };`,
    });
    const observed = () => JSON.parse(readFileSync(observationFile, "utf8"));
    const registry = loadPlugins([plugin], { activate });
    try {
      expect(registry.plugins[0]?.status).toBe("loaded");
      const expected = (phase: string) => ({
        phase,
        // Admitted registration and callbacks can share scratch state without global activation.
        set: true,
        value: { phase },
        event: activate
          ? { emitted: true, stream: `${id}.startup` }
          : { emitted: false, reason: "global side effects disabled" },
        cleared: true,
      });
      expect(observed()).toEqual(expected("register"));
      const factory = registry.tools[0]!.factory;
      expect(factory({})).toBeNull();
      expect(observed()).toEqual(expected("callback"));
      await disposePluginRegistryInstances(registry);
      expect(() => factory({})).toThrow();
      expect(observed()).toEqual(expected("callback"));
    } finally {
      await disposePluginRegistryInstances(registry);
      if (activate) {
        await clearActivePluginRegistry();
      }
    }
  },
);

it.each([true, false])(
  "retires successful cached instances but preserves caller-owned handles (cache: %s)",
  async (cached) => {
    const event = `successful-cache-retirement-${cached}`;
    using probe = eventProbe(event);
    const order: string[] = [];
    const cleanupEvent = `${event}-cleanup`;
    const observeCleanup = (step: string) => order.push(step);
    process.on(cleanupEvent, observeCleanup);
    const plugin = writeToolPlugin({
      id: `cache-owner-${cached}`,
      tool: "cache_probe",
      body: `const listener = () => {}; process.on(${JSON.stringify(event)}, listener); module.exports = {
        id: "cache-owner-${cached}", register(api) {
          api.registerTool(() => null, { names: ["cache_probe"] });
          api.registerRuntimeLifecycle({ id: "cache-cleanup", cleanup() {
            process.emit(${JSON.stringify(cleanupEvent)}, api.lifecycle.signal.aborted ? "host-aborted" : "host-live");
          } });
          api.lifecycle.onDispose(() => {
            process.off(${JSON.stringify(event)}, listener);
            process.emit(${JSON.stringify(cleanupEvent)}, "instance");
          });
        }
      };`,
    });
    await using owner = loaded(plugin, { cache: cached });
    const { cache, registry } = owner;
    try {
      expect(registry.plugins[0]?.status).toBe("loaded");
      expect(probe.count()).toBe(1);
      if (cached) {
        expect(owner.reload()).toBe(registry);
      }
      withPluginCache(cache, clearPluginRegistryLoadCache);
      expect(probe.count()).toBe(1);
      expect(registry.tools[0]?.factory({})).toBe(null);
      await retirePluginCache(cache);
      expect(probe.count()).toBe(cached ? 0 : 1);
      expect(order).toEqual(cached ? ["host-live", "instance"] : []);
      if (!cached) {
        expect(registry.tools[0]?.factory({})).toBe(null);
      }
    } finally {
      process.off(cleanupEvent, observeCleanup);
    }
  },
);

it("preserves an adopted published instance across cache retirement", async () => {
  const event = "cache-active-adopted";
  using probe = eventProbe(event);
  const plugin = writeResourceTool({
    id: "active-adopted",
    setup: `const listener = () => {}; process.on(${JSON.stringify(event)}, listener);`,
    cleanup: `process.off(${JSON.stringify(event)}, listener);`,
    value: `(await import("./lazy.mjs")).value`,
  });
  const helper = path.join(plugin.dir, "lazy.mjs");
  writeFileSync(helper, 'export const value = "captured";');
  await using owner = loaded(plugin, { cache: true });
  const { cache, registry } = owner;
  try {
    const tool = toolFor(registry);
    setActivePluginRegistry(registry);
    setActivePluginRegistry({ ...registry, plugins: [...registry.plugins] });
    writeFileSync(helper, 'export const value = "edited after capture";');
    await retirePluginCache(cache);
    expect(probe.count()).toBe(1);
    await expectToolText(tool, "first-lazy-import", "captured");
    await clearActivePluginRegistry();
    expect(probe.count()).toBe(0);
    await expect(
      Promise.resolve().then(() => tool.execute("after-retirement", {})),
    ).rejects.toThrow("reloaded or disabled");
  } finally {
    await clearActivePluginRegistry();
  }
});

it("keeps a module-scope resource open for the republished instance after the old one retires", async () => {
  const id = "module-resource-republish";
  // Canonical external-plugin pattern: open a resource at import, close it in onDispose.
  const plugin = writeResourceTool({
    id,
    setup: `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(":memory:");`,
    cleanup: `if (db.isOpen) db.close();`,
    value: `String(db.prepare("select 7 as v").get().v)`,
  });
  await using previous = loaded(plugin);
  await using next = loaded(plugin);
  const tool = toolFor(next.registry);
  await previous[Symbol.asyncDispose]();
  await expectToolText(tool, "after-republish", "7");
});

it("preserves body and unexpected registry retirement failures with async disposal", async () => {
  const operationError = new Error("operation failed");
  const cleanupError = new Error("registry retirement failed");
  const cleanup = vi.fn();
  const retireRegistry = vi.fn(async () => {
    throw cleanupError;
  });
  const run = async () => {
    await using cache = createPluginCache();
    const instance = new PluginInstance("async-disposable-cache");
    instance.lifecycle.onDispose(cleanup);
    cache.setupModules.set(instance.pluginId, instance);
    cache.retireRegistryLoads = retireRegistry;
    throw operationError;
  };
  const failure: unknown = await run().catch((error: unknown) => error);
  const suppressed = asOptionalRecord(failure);
  expect(suppressed?.name).toBe("SuppressedError");
  expect(suppressed?.suppressed).toBe(operationError);
  expect(
    collectErrorGraphCandidates(suppressed?.error, (error) =>
      error instanceof AggregateError ? error.errors : [],
    ),
  ).toContain(cleanupError);
  expect(retireRegistry).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(["load", "register", "id-mismatch", "disabled-memory"] as const)(
  "records plugin %s outcome and cleans only registered native resources",
  async (phase) => {
    const event = `plugin-failure-${phase}`;
    using probe = eventProbe(event);
    const acquire = `const listener = () => {}; process.on(${JSON.stringify(event)}, listener);`;
    const body = {
      load: `${acquire} throw new Error("fixture failed");`,
      register: `module.exports = { id: "failed-register", register(api) {
        ${acquire}
        api.lifecycle.onDispose(() => process.off(${JSON.stringify(event)}, listener));
        throw new Error("fixture failed");
      } };`,
      "id-mismatch": `${acquire} module.exports = { id: "wrong-owner", register() {} };`,
      "disabled-memory": `${acquire} module.exports = { id: "failed-disabled-memory", kind: "memory", register() {
        throw new Error("disabled plugin registered");
      } };`,
    }[phase]!;
    const plugin = writePlugin({ id: `failed-${phase}`, body });
    await using owner = loaded(plugin);
    const { registry } = owner;
    expect(registry.plugins).toEqual([
      expect.objectContaining(
        phase === "disabled-memory"
          ? {
              id: plugin.id,
              enabled: false,
              status: "disabled",
              activationReason: expect.stringContaining("memory slot"),
            }
          : {
              id: plugin.id,
              status: "error",
              failurePhase: phase === "load" || phase === "register" ? phase : "validation",
              error: expect.stringContaining(
                phase === "id-mismatch" ? "plugin id mismatch" : "fixture failed",
              ),
            },
      ),
    ]);
    if (phase === "register") {
      await vi.waitFor(() => expect(probe.count()).toBe(0));
    } else {
      await disposePluginRegistryInstances(registry);
      expect(probe.count()).toBe(1);
    }
  },
);

it("retires every unpublished instance when a nonactivating builder throws", async () => {
  const event = "plugin-abandoned-builder";
  const before = process.listenerCount(event);
  const plugins = [
    writePlugin({
      id: "abandoned-a",
      body: `const listener = () => {}; process.on(${JSON.stringify(event)}, listener);
        module.exports = { id: "abandoned-a", register(api) {
          api.lifecycle.onDispose(() => process.off(${JSON.stringify(event)}, listener));
        } };`,
    }),
    writePlugin({ id: "abandoned-z", body: 'throw new Error("later plugin failed");' }),
  ];
  await using cache = createPluginCache();
  expect(() =>
    withPluginCache(cache, () => loadPlugins(plugins, { throwOnLoadError: true })),
  ).toThrow("later plugin failed");
  await retirePluginCache(cache);
  expect(process.listenerCount(event)).toBe(before);
});

it("joins failed registration cleanup through cache retirement and preserves both failures", async () => {
  const event = "plugin-pending-rollback-cleanup";
  const entered = createDeferredCore();
  let release: (() => void) | undefined;
  const onCleanup = vi.fn((done: () => void) => {
    release = done;
    entered.resolve();
  });
  process.once(event, onCleanup);
  const plugin = writePlugin({
    id: "async-rollback",
    body: `module.exports = { id: "async-rollback", register(api) {
      api.lifecycle.onDispose(async () => {
        await new Promise(resolve => process.emit(${JSON.stringify(event)}, resolve));
        throw new Error("async cleanup failed");
      });
      throw new Error("original register failure");
    } };`,
  });
  const cache = createPluginCache();
  let registry: ReturnType<typeof loadOpenClawPlugins> | undefined;
  let retirement: ReturnType<typeof retirePluginCache> | undefined;
  try {
    registry = withPluginCache(cache, () => loadPlugins([plugin], { cache: true }));
    expect(registry.plugins[0]?.error).toContain("original register failure");
    await entered.promise;
    let settled = false;
    retirement = retirePluginCache(cache);
    observeSettlement(retirement, () => {
      settled = true;
    });
    await nextTurn();
    expect.soft(settled).toBe(false);
    release!();
    const result = await retirement;
    expect(result.failures).toEqual([
      {
        pluginId: plugin.id,
        hookId: "instance",
        error: expect.objectContaining({ message: "async cleanup failed" }),
      },
    ]);
    expect(registry.plugins[0]?.error).toContain("original register failure");
    expect(onCleanup).toHaveBeenCalledOnce();
  } finally {
    release?.();
    await retirement;
    if (registry) {
      await disposePluginRegistryInstances(registry).catch(() => {});
    }
    await retirePluginCache(cache).catch(() => {});
    process.removeListener(event, onCleanup);
  }
});

it.each([false, true])(
  "closes loader admission before setup abort (settlement: %s)",
  async (waitForSettlement) => {
    const cache = createPluginCache();
    const instance = new PluginInstance("retiring-setup");
    cache.setupModules.set(instance.pluginId, instance);
    let failure: unknown;
    instance.lifecycle.signal.addEventListener("abort", () => {
      try {
        withPluginCache(cache, () => loadOpenClawPlugins({ onlyPluginIds: [], activate: false }));
      } catch (error) {
        failure = error;
      }
    });
    await retirePluginCache(cache, undefined, { waitForSettlement });
    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringContaining("retired") }),
    );
  },
);

it("rejects deferred runtime loading after cache retirement completes", async () => {
  const event = "retired-loader";
  const count = process.listenerCount(event);
  const plugin = writePlugin({
    id: "late-plugin",
    body: `process.on(${JSON.stringify(event)}, () => {}); module.exports = { id: "late-plugin", register() {} };`,
  });
  const cache = createPluginCache();
  const resume = createDeferredCore();
  let registry: ReturnType<typeof loadOpenClawPlugins> | undefined;
  const loading = withPluginCache(cache, async () => {
    await resume.promise;
    return (registry = loadPlugins([plugin], { cache: true }));
  });
  const rejected = expect(loading).rejects.toThrow("retired");
  const retiring = retirePluginCache(cache);
  try {
    await retiring;
    resume.resolve();
    await rejected;
    expect(process.listenerCount(event)).toBe(count);
  } finally {
    resume.resolve();
    await loading.catch(() => {});
    if (registry) {
      await disposePluginRegistryInstances(registry);
    }
    await retiring;
  }
});
