import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { collectErrorGraphCandidates } from "../infra/errors.js";
import { createDeferredCore } from "../shared/deferred.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import {
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "./plugin-cache.js";
import { PluginInstance } from "./plugin-instance.js";
import {
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "./runtime.js";

it.each([true, false])(
  "keeps workflow admission through registration and retirement (activate: %s)",
  async (activate) => {
    useNoBundledPlugins();
    const id = `registration-workflow-${activate}`;
    const observationFile = path.join(makePluginLoaderTempDir(), "observed.json");
    const plugin = writePlugin({
      id,
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
    writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id,
        configSchema: { type: "object", properties: {} },
        contracts: { tools: ["workflow_probe"] },
      }),
    );
    const observed = () => JSON.parse(readFileSync(observationFile, "utf8"));
    const registry = loadOpenClawPlugins({
      config: {
        plugins: { allow: [id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
      },
      activate,
      cache: false,
    });
    try {
      expect(registry.plugins[0]?.status).toBe("loaded");
      const expected = (phase: string) => ({
        phase,
        set: activate,
        ...(activate ? { value: { phase } } : {}),
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
      resetPluginLoaderTestStateForTest();
    }
  },
);

it.each([true, false])(
  "retires successful cached instances but preserves caller-owned handles (cache: %s)",
  async (cached) => {
    useNoBundledPlugins();
    const event = `successful-cache-retirement-${cached}`;
    const before = process.listenerCount(event);
    const order: string[] = [];
    const cleanupEvent = `${event}-cleanup`;
    const observeCleanup = (step: string) => order.push(step);
    process.on(cleanupEvent, observeCleanup);
    const plugin = writePlugin({
      id: `cache-owner-${cached}`,
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
    writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object", properties: {} },
        contracts: { tools: ["cache_probe"] },
      }),
    );
    const cache = createPluginCache();
    const options = {
      config: {
        plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
      },
      cache: cached,
      activate: false,
    };
    const registry = withPluginCache(cache, () => loadOpenClawPlugins(options));
    try {
      expect(registry.plugins[0]?.status).toBe("loaded");
      expect(process.listenerCount(event)).toBe(before + 1);
      if (cached) {
        expect(withPluginCache(cache, () => loadOpenClawPlugins(options))).toBe(registry);
      }
      withPluginCache(cache, clearPluginRegistryLoadCache);
      expect(process.listenerCount(event)).toBe(before + 1);
      expect(registry.tools[0]?.factory({})).toBe(null);
      await retirePluginCache(cache);
      expect(process.listenerCount(event)).toBe(before + (cached ? 0 : 1));
      expect(order).toEqual(cached ? ["host-live", "instance"] : []);
      if (!cached) {
        expect(registry.tools[0]?.factory({})).toBe(null);
      }
    } finally {
      await disposePluginRegistryInstances(registry);
      await retirePluginCache(cache);
      process.off(cleanupEvent, observeCleanup);
      resetPluginLoaderTestStateForTest();
    }
  },
);

it.each([false, true])(
  "preserves a published exact instance across cache retirement (adopted: %s)",
  async (adopted) => {
    useNoBundledPlugins();
    const event = `cache-active-${adopted}`;
    const before = process.listenerCount(event);
    const plugin = writePlugin({
      id: `active-${adopted}`,
      body: `const listener = () => {}; process.on(${JSON.stringify(event)}, listener); module.exports = {
      id: "active-${adopted}", register(api) {
        api.lifecycle.onDispose(() => process.off(${JSON.stringify(event)}, listener));
        api.registerTool({ name: "active_probe", description: "Read a captured helper",
          parameters: { type: "object", properties: {} },
          async execute() {
            return { content: [{ type: "text", text: (await import("./lazy.mjs")).value }] };
          }
        });
      }
    };`,
    });
    const helper = path.join(plugin.dir, "lazy.mjs");
    writeFileSync(helper, 'export const value = "captured";');
    writeFileSync(
      path.join(plugin.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object", properties: {} },
        contracts: { tools: ["active_probe"] },
      }),
    );
    const cache = createPluginCache();
    const registry = withPluginCache(cache, () =>
      loadOpenClawPlugins({
        config: {
          plugins: {
            allow: [plugin.id],
            load: { paths: [plugin.file] },
            slots: { memory: "none" },
          },
        },
        activate: false,
      }),
    );
    try {
      const tool = registry.tools[0]?.factory({});
      if (!tool || Array.isArray(tool)) {
        throw new Error("Expected the registered lazy-import probe");
      }
      setActivePluginRegistry(registry);
      if (adopted) {
        setActivePluginRegistry({ ...registry, plugins: [...registry.plugins] });
      }
      writeFileSync(helper, 'export const value = "edited after capture";');
      await retirePluginCache(cache);
      expect(process.listenerCount(event)).toBe(before + 1);
      await expect(tool.execute("first-lazy-import", {})).resolves.toMatchObject({
        content: [{ type: "text", text: "captured" }],
      });
      await clearActivePluginRegistry();
      expect(process.listenerCount(event)).toBe(before);
      await expect(
        Promise.resolve().then(() => tool.execute("after-retirement", {})),
      ).rejects.toThrow("reloaded or disabled");
    } finally {
      await clearActivePluginRegistry();
      await retirePluginCache(cache);
      resetPluginLoaderTestStateForTest();
    }
  },
);

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

it.each(["load", "register", "id-mismatch", "missing-register"] as const)(
  "records plugin %s failure and cleans only registered native resources",
  async (phase) => {
    useNoBundledPlugins();
    const event = `plugin-failure-${phase}`;
    const previousListeners = process.listeners(event);
    const listenerCount = previousListeners.length;
    const acquire = `const listener = () => {}; process.on(${JSON.stringify(event)}, listener);`;
    const body = {
      load: `${acquire} throw new Error("fixture failed");`,
      register: `module.exports = { id: "failed-register", register(api) {
        ${acquire}
        api.lifecycle.onDispose(() => process.off(${JSON.stringify(event)}, listener));
        throw new Error("fixture failed");
      } };`,
      "id-mismatch": `${acquire} module.exports = { id: "wrong-owner", register() {} };`,
      "missing-register": `${acquire} module.exports = { id: "failed-missing-register" };`,
    }[phase]!;
    const plugin = writePlugin({ id: `failed-${phase}`, body });
    const registry = loadOpenClawPlugins({
      config: {
        plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
      },
      cache: false,
      activate: false,
    });
    const fixtureListeners = process
      .listeners(event)
      .filter((listener) => !previousListeners.includes(listener));
    try {
      expect(registry.plugins).toEqual([
        expect.objectContaining({
          id: plugin.id,
          status: "error",
          failurePhase: phase === "load" || phase === "register" ? phase : "validation",
          error: expect.stringContaining(
            phase === "id-mismatch"
              ? "plugin id mismatch"
              : phase === "missing-register"
                ? "missing register/activate"
                : "fixture failed",
          ),
        }),
      ]);
      if (phase === "register") {
        await vi.waitFor(() => expect(process.listenerCount(event)).toBe(listenerCount));
      } else {
        await disposePluginRegistryInstances(registry);
        expect(process.listenerCount(event)).toBe(listenerCount + 1);
      }
    } finally {
      try {
        await disposePluginRegistryInstances(registry);
      } finally {
        for (const listener of fixtureListeners) {
          process.off(event, listener);
        }
        resetPluginLoaderTestStateForTest();
      }
    }
  },
);

it("records a disabled runtime-only memory plugin without promising native effect cleanup", async () => {
  useNoBundledPlugins();
  const event = "plugin-disabled-memory";
  const previousListeners = process.listeners(event);
  const before = previousListeners.length;
  const plugin = writePlugin({
    id: "runtime-memory",
    body: `process.on(${JSON.stringify(event)}, () => {});
      module.exports = { id: "runtime-memory", kind: "memory", register() {
        throw new Error("disabled plugin registered");
      } };`,
  });
  const registry = loadOpenClawPlugins({
    config: {
      plugins: { allow: [plugin.id], load: { paths: [plugin.file] }, slots: { memory: "none" } },
    },
    cache: false,
    activate: false,
  });
  const fixtureListeners = process
    .listeners(event)
    .filter((listener) => !previousListeners.includes(listener));
  try {
    expect(registry.plugins).toEqual([
      expect.objectContaining({
        id: plugin.id,
        enabled: false,
        status: "disabled",
        activationReason: expect.stringContaining("memory slot"),
      }),
    ]);
    await disposePluginRegistryInstances(registry);
    expect(process.listenerCount(event)).toBe(before + 1);
  } finally {
    try {
      await disposePluginRegistryInstances(registry);
    } finally {
      for (const listener of fixtureListeners) {
        process.off(event, listener);
      }
      resetPluginLoaderTestStateForTest();
    }
  }
});

it("retires every unpublished instance when a nonactivating builder throws", async () => {
  useNoBundledPlugins();
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
  const cache = createPluginCache();
  try {
    expect(() =>
      withPluginCache(cache, () =>
        loadOpenClawPlugins({
          config: {
            plugins: {
              allow: plugins.map((p) => p.id),
              load: { paths: plugins.map((p) => p.file) },
              slots: { memory: "none" },
            },
          },
          cache: false,
          activate: false,
          throwOnLoadError: true,
        }),
      ),
    ).toThrow("later plugin failed");
    await retirePluginCache(cache);
    expect(process.listenerCount(event)).toBe(before);
  } finally {
    await retirePluginCache(cache);
    resetPluginLoaderTestStateForTest();
  }
});

it("joins failed registration cleanup through cache retirement and preserves both failures", async () => {
  useNoBundledPlugins();
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
    registry = withPluginCache(cache, () =>
      loadOpenClawPlugins({
        config: {
          plugins: {
            allow: [plugin.id],
            load: { paths: [plugin.file] },
            slots: { memory: "none" },
          },
        },
        activate: false,
      }),
    );
    expect(registry.plugins[0]?.error).toContain("original register failure");
    await entered.promise;
    let settled = false;
    retirement = retirePluginCache(cache);
    void retirement.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
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
    resetPluginLoaderTestStateForTest();
  }
});

it("closes loader admission before a retiring setup owner's abort callback", async () => {
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
  await retirePluginCache(cache);
  expect(failure).toEqual(expect.objectContaining({ message: expect.stringContaining("retired") }));
});

it.each(["starting", "completed"] as const)(
  "rejects deferred runtime loading after cache retirement is %s",
  async (phase) => {
    useNoBundledPlugins();
    const event = `retired-loader-${phase}`;
    const count = process.listenerCount(event);
    const plugin = writePlugin({
      id: `late-${phase}`,
      body: `process.on(${JSON.stringify(event)}, () => {}); module.exports = { id: "late-${phase}", register() {} };`,
    });
    const cache = createPluginCache();
    const resume = createDeferredCore();
    let registry: ReturnType<typeof loadOpenClawPlugins> | undefined;
    const loading = withPluginCache(cache, async () => {
      await resume.promise;
      return (registry = loadOpenClawPlugins({
        config: {
          plugins: {
            allow: [plugin.id],
            load: { paths: [plugin.file] },
            slots: { memory: "none" },
          },
        },
        activate: false,
      }));
    });
    const rejected = expect(loading).rejects.toThrow("retired");
    const retiring = retirePluginCache(cache);
    try {
      if (phase === "completed") {
        await retiring;
      }
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
      resetPluginLoaderTestStateForTest();
    }
  },
);
