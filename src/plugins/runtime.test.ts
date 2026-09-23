/** Covers plugin runtime registration API behavior and registry mutation guards. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { GatewayConnectionWork } from "../gateway/server-connection-work.js";
import { runGatewayCloseSteps } from "../gateway/server-shutdown.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getPluginRunContext, setPluginRunContext } from "./host-hook-runtime.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  isPluginRegistryRetired,
} from "./registry-lifecycle.js";
import type { PluginHttpRouteRegistration } from "./registry-types.js";
import { getPluginRegistryState } from "./runtime-state.js";
import {
  captureActivePluginRegistrySnapshot,
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  listImportedRuntimePluginIds,
  recordImportedPluginId,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

async function waitForCleanupSignal(signal: Promise<void>, label: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 500);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

const makeRoute = (path: string): PluginHttpRouteRegistration => ({
  path,
  handler: () => {},
  auth: "gateway",
  match: "exact",
});

describe("setActivePluginRegistry", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("does not carry forward httpRoutes when new registry has none", () => {
    const oldRegistry = createEmptyPluginRegistry();
    const fakeRoute = makeRoute("/test");
    oldRegistry.httpRoutes.push(fakeRoute);
    setActivePluginRegistry(oldRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);

    const newRegistry = createEmptyPluginRegistry();
    expect(newRegistry.httpRoutes).toHaveLength(0);
    setActivePluginRegistry(newRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(0);
  });

  it("does not carry forward when new registry already has routes", () => {
    const oldRegistry = createEmptyPluginRegistry();
    oldRegistry.httpRoutes.push(makeRoute("/old"));
    setActivePluginRegistry(oldRegistry);

    const newRegistry = createEmptyPluginRegistry();
    const newRoute = makeRoute("/new");
    newRegistry.httpRoutes.push(newRoute);
    setActivePluginRegistry(newRegistry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);
    expect(getActivePluginRegistry()?.httpRoutes[0]).toEqual(newRoute);
  });

  it("does not carry forward when same registry is set again", () => {
    const registry = createEmptyPluginRegistry();
    registry.httpRoutes.push(makeRoute("/test"));
    setActivePluginRegistry(registry);
    setActivePluginRegistry(registry);
    expect(getActivePluginRegistry()?.httpRoutes).toHaveLength(1);
  });

  it.each(["empty", "loaded"] as const)(
    "keeps a reactivated %s registry live after displaced cleanup",
    async (kind) => {
      const { withPluginCommandExecution } = await import("./command-execution-lock.js");
      const original = createEmptyPluginRegistry();
      if (kind === "loaded") {
        original.plugins.push(createPluginRecord({ id: "reactivated", status: "loaded" }));
      }
      const temporary = createEmptyPluginRegistry();
      onTestFinished(() => clearActivePluginRegistry());
      setActivePluginRegistry(original);
      setActivePluginRegistry(temporary);
      setActivePluginRegistry(original);

      await clearActivePluginRegistry(temporary);

      expect(getActivePluginRegistry()).toBe(original);
      expect(await withPluginCommandExecution(original, () => "current")).toEqual({
        admitted: true,
        value: "current",
      });
    },
  );

  it("does not treat bundle-only loaded entries as imported runtime plugins", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "bundle-only",
        name: "Bundle Only",
        source: "/tmp/bundle",
        origin: "bundled",
        format: "bundle",
        configSchema: true,
      }),
      createPluginRecord({
        id: "runtime-plugin",
        name: "Runtime Plugin",
        source: "/tmp/runtime",
        format: "openclaw",
        configSchema: true,
      }),
    );

    setActivePluginRegistry(registry);

    expect(listImportedRuntimePluginIds()).toEqual(["runtime-plugin"]);
  });

  it.each([
    {
      name: "same active registry is refreshed",
      refresh: (nextRegistry: ReturnType<typeof createEmptyPluginRegistry>) => {
        setActivePluginRegistry(nextRegistry);
      },
    },
    {
      name: "active registry advances again",
      refresh: () => {
        setActivePluginRegistry(createEmptyPluginRegistry());
      },
    },
  ] as const)("continues cleanup when the $name", async ({ refresh }) => {
    const firstCleanupStarted = createDeferredCore();
    const firstCleanupReleased = createDeferredCore();
    const secondCleanupCalled = createDeferredCore();
    onTestFinished(() => firstCleanupReleased.resolve());
    const previous = createEmptyPluginRegistry();
    previous.plugins.push(
      createPluginRecord({
        id: "cleanup-refresh-race",
        name: "Cleanup Refresh Race",
        status: "loaded",
      }),
    );
    previous.runtimeLifecycles = [
      {
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle: {
          id: "first-cleanup",
          async cleanup() {
            firstCleanupStarted.resolve();
            await firstCleanupReleased.promise;
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
      {
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle: {
          id: "second-cleanup",
          cleanup() {
            secondCleanupCalled.resolve();
          },
        },
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      },
    ];
    const next = createEmptyPluginRegistry();

    setActivePluginRegistry(previous);
    setActivePluginRegistry(next);
    // The race starts inside cleanup; cold lazy imports are not a cleanup deadline.
    await firstCleanupStarted.promise;

    refresh(next);
    firstCleanupReleased.resolve();

    await waitForCleanupSignal(secondCleanupCalled.promise, "second cleanup");
  });

  it("includes plugin ids imported before registration failed", () => {
    recordImportedPluginId("broken-plugin");

    expect(listImportedRuntimePluginIds()).toEqual(["broken-plugin"]);
  });

  it.each(["instance", "runtime"] as const)(
    "keeps %s plugin cleanup admitted through the restart connection drain",
    async (kind) => {
      const owner = new GatewayConnectionWork();
      const registry = createEmptyPluginRegistry();
      const record = createPluginRecord({ id: "closing-scope", status: "loaded" });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      const initialize = createDeferredCore();
      const cleanupStarted = createDeferredCore();
      const finishCleanup = createDeferredCore();
      const cleaned = vi.fn();
      const cleanup = () =>
        trackAsyncWork(async () => {
          cleanupStarted.resolve();
          await finishCleanup.promise;
          cleaned();
        });
      if (kind === "instance") {
        instance.lifecycle.onDispose(cleanup);
      } else {
        registry.runtimeLifecycles.push({
          pluginId: record.id,
          source: record.source,
          rootDir: record.rootDir,
          lifecycle: { id: "tracked-store-close", cleanup },
        });
      }
      let retirement: ReturnType<typeof disposePluginRegistryInstances> | undefined;
      const request = owner.track(() => {
        retirement = disposePluginRegistryInstances(registry, undefined, {
          beforeDispose: () => initialize.promise,
        });
        void retirement.catch(() => {});
      });
      let closed = false;
      const onError = vi.fn();
      const drain = runGatewayCloseSteps({
        owner: {
          connectionWork: owner,
          stopConnectionDependentSidecars() {},
          stopRegisteredGatewayLifetimeSidecars() {},
          stopRegisteredPostReadySidecars() {},
          runClosePrelude() {},
          sealAndJoinRegisteredSidecarStops() {},
        },
        disposeTerminalSessions: () => {
          closed = true;
        },
        close: async () => {
          await retirement;
        },
        onError,
      });
      try {
        await request;
        await nextTurn();
        expect(closed).toBe(false);
        initialize.resolve();
        await cleanupStarted.promise;
        await nextTurn();
        expect(closed).toBe(false);
        finishCleanup.resolve();
        await expect(retirement).resolves.toMatchObject({ failures: [] });
        await drain;
        expect(cleaned).toHaveBeenCalledOnce();
        expect(closed).toBe(true);
        expect(onError).not.toHaveBeenCalled();
        await expect(owner.track(() => undefined)).rejects.toThrow("Async work scope is closed");
      } finally {
        initialize.resolve();
        finishCleanup.resolve();
        await Promise.allSettled([retirement, drain]);
      }
    },
  );

  it("clears the root only after its host cleanup completes", async () => {
    let cleanupCount = 0;
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({ id: "cleanup-on-close", name: "Cleanup on close", status: "loaded" }),
    );
    registry.runtimeLifecycles = [
      {
        pluginId: "cleanup-on-close",
        pluginName: "Cleanup on close",
        lifecycle: {
          id: "cleanup-on-close",
          cleanup() {
            cleanupCount += 1;
          },
        },
        source: "/virtual/cleanup-on-close/index.ts",
        rootDir: "/virtual/cleanup-on-close",
      },
    ];
    setActivePluginRegistry(registry);

    await clearActivePluginRegistry();

    expect(getActivePluginRegistry()).toBeNull();
    expect(cleanupCount).toBe(1);
  });

  it("joins a displaced cleanup scope created before package replacement", async () => {
    const registry = createEmptyPluginRegistry();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    registry.runtimeLifecycles.push({
      pluginId: "released-scope",
      source: "/virtual/released-scope/index.ts",
      lifecycle: {
        id: "held-cleanup",
        cleanup: async () => {
          entered.resolve();
          await finish.promise;
        },
      },
    });
    setActivePluginRegistry(registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    await entered.promise;
    const pending = [...(getPluginRegistryState()?.retiredRegistryCleanups ?? [])].find(
      ([, cleanup]) => cleanup.registry === registry,
    );
    assert(pending);
    const [settled, { work }] = pending;
    // The retained v2026.9.5 scope has no newer prototype method.
    Object.defineProperty(work, "isActiveHere", { value: undefined });
    const closing = clearActivePluginRegistry();
    void closing.catch(() => {});
    try {
      finish.resolve();
      await expect(closing).resolves.toBeUndefined();
      expect(getActivePluginRegistry()).toBeNull();
    } finally {
      finish.resolve();
      await settled;
      await closing.catch(() => {});
      await clearActivePluginRegistry();
    }
  });

  it.each(["host", "module", "module abort descendant"] as const)(
    "lets retired %s cleanup clear its successor without joining itself",
    async (kind) => {
      const registry = createEmptyPluginRegistry();
      const started = createDeferredCore();
      const finished = createDeferredCore();
      const escape = createDeferredCore();
      let clearing: Promise<void> | undefined;
      const cleanup = vi.fn(async () => {
        started.resolve();
        clearing = clearActivePluginRegistry();
        await Promise.race([clearing, escape.promise]);
        finished.resolve();
      });
      if (kind !== "host") {
        const record = createPluginRecord({ id: "reentrant-cleanup", status: "loaded" });
        registry.plugins.push(record);
        const instance = new PluginInstance(record.id, { record, registry });
        instance.onModuleDispose(() => undefined);
        if (kind === "module abort descendant") {
          instance.lifecycle.signal.addEventListener("abort", () => {
            void trackAsyncWork(cleanup);
          });
        }
      }
      if (kind !== "module abort descendant") {
        registry.runtimeLifecycles.push({
          pluginId: "reentrant-cleanup",
          lifecycle: { id: "clear-successor", cleanup },
          source: "/virtual/reentrant-cleanup/index.ts",
        });
      }
      setActivePluginRegistry(registry);
      setActivePluginRegistry(createEmptyPluginRegistry());

      try {
        await started.promise;
        await waitForCleanupSignal(finished.promise, "reentrant retired cleanup");
        expect(cleanup).toHaveBeenCalledOnce();
        expect(getActivePluginRegistry()).toBeNull();
      } finally {
        escape.resolve();
        await clearing;
        await clearActivePluginRegistry();
      }
    },
  );

  it.each([
    "install",
    "staged",
    "clear",
    "activation-install",
    "activation-staged",
    "activation-install-replace",
    "activation-staged-replace",
    "catalog-install",
    "catalog-staged",
  ] as const)(
    "keeps an admitted command live through a reentrant retirement abort (%s)",
    async (retirement) => {
      const { createPluginRegistry } = await import("./registry.js");
      const { createPluginRuntime } = await import("./runtime/index.js");
      const { activatePluginRegistry } = await import("./loader-shared.js");
      const { withPluginCommandExecution } = await import("./command-execution-lock.js");
      const builder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntime(),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "abort-cleanup-sqlite", status: "loaded" });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      const db = new DatabaseSync(":memory:");
      const nativeState = resolveGlobalSingleton(
        Symbol.for("openclaw.test.actualPluginCleanupDatabase"),
        (): { database?: DatabaseSync; resets: number } => ({ resets: 0 }),
        (state) => {
          if (state.database?.isOpen) {
            state.resets++;
            state.database.close();
          }
        },
        "plugin-registry",
      );
      nativeState.database = db;
      nativeState.resets = 0;
      const cleanup = vi.fn(() => {
        expect(db.prepare("SELECT 2 AS value").get()).toEqual({ value: 2 });
      });
      api.lifecycle.registerRuntimeLifecycle({ id: "abort-cleanup", cleanup });
      setActivePluginRegistry(builder.registry);
      const catalogReentry = retirement.startsWith("catalog-");
      const successorBuilder = catalogReentry
        ? createPluginRegistry({
            logger: { info() {}, warn() {}, error() {}, debug() {} },
            runtime: createPluginRuntime(),
            activateGlobalSideEffects: false,
          })
        : undefined;
      const successor = successorBuilder?.registry ?? createEmptyPluginRegistry();
      const newer = createEmptyPluginRegistry();
      const replaceAgain = retirement.endsWith("-replace");
      const staged = retirement.split("-").includes("staged");
      const signal = retirement.startsWith("activation-")
        ? capturePluginRegistryLifecycleSignal(successor, undefined, { scopedRuntime: true })
        : capturePluginRegistryLifecycleSignal(
            builder.registry,
            capturePluginRegistryLifecycleEpoch(builder.registry),
          );
      if (!signal) {
        throw new Error("Expected an active registry lifecycle signal");
      }
      let innerClear: Promise<void> | undefined;
      let outerClear: Promise<void> | undefined;
      const reenter = () => {
        if (replaceAgain) {
          activatePluginRegistry(newer, "newer", "gateway-bindable", "/virtual/newer");
          innerClear = Promise.resolve();
        } else {
          innerClear = clearActivePluginRegistry();
        }
      };
      if (successorBuilder) {
        const channelRecord = createPluginRecord({ id: "catalog-reentry", status: "loaded" });
        successor.plugins.push(channelRecord);
        successorBuilder.createApi(channelRecord, { config: {} }).registerChannel({
          plugin: {
            id: channelRecord.id,
            meta: {
              id: channelRecord.id,
              label: "Catalog reentry",
              selectionLabel: "Catalog reentry",
              docsPath: "/channels/catalog-reentry",
              blurb: "Catalog lifecycle fixture",
            },
            capabilities: { chatTypes: ["direct"] },
            config: {
              listAccountIds: () => [],
              resolveAccount: () => ({ accountId: "default" }),
            },
            message: {
              get durableFinal() {
                if (getActivePluginRegistry() === successor) {
                  reenter();
                }
                return undefined;
              },
            },
          },
        });
      } else {
        signal.addEventListener("abort", reenter);
      }
      const escape = createDeferredCore();
      const commandRead = createDeferredCore();
      const releaseCommand = createDeferredCore();
      const reads: unknown[] = [];
      const failures: unknown[] = [];
      const activationErrors: unknown[] = [];
      const command = withPluginCommandExecution(builder.registry, async () => {
        if (retirement === "clear") {
          outerClear = clearActivePluginRegistry();
        } else if (staged) {
          try {
            activatePluginRegistry(successor, "successor", "explicit", "/virtual/successor");
          } catch (error) {
            activationErrors.push(error);
          }
        } else {
          setActivePluginRegistry(successor, "successor", "explicit", "/virtual/successor");
        }
        if (!innerClear) {
          throw new Error("Expected synchronous retirement notification");
        }
        await Promise.race([innerClear, escape.promise]);
        try {
          reads.push(db.prepare("SELECT 1 AS value").get());
        } catch (error) {
          failures.push(error);
        }
        commandRead.resolve();
        await releaseCommand.promise;
      });
      try {
        await waitForCleanupSignal(commandRead.promise, "command after retirement abort clear");
        expect(failures).toEqual([]);
        expect(reads).toEqual([{ value: 1 }]);
        expect(db.isOpen).toBe(true);
        expect(nativeState.resets).toBe(0);
        expect(cleanup).not.toHaveBeenCalled();
        if (catalogReentry) {
          expect(isPluginRegistryRetired(successor)).toBe(true);
        }
        expect(captureActivePluginRegistrySnapshot()).toEqual(
          replaceAgain
            ? {
                activeRegistry: newer,
                key: "newer",
                workspaceDir: "/virtual/newer",
                runtimeSubagentMode: "gateway-bindable",
              }
            : {
                activeRegistry: null,
                key: null,
                workspaceDir: null,
                runtimeSubagentMode: "default",
              },
        );
        expect(activationErrors).toEqual(
          staged
            ? [expect.objectContaining({ message: "Plugin registry activation was superseded" })]
            : [],
        );
        if (replaceAgain) {
          const { getGlobalPluginRegistry } = await import("./hook-runner-global.js");
          expect(getGlobalPluginRegistry()).toBe(newer);
        }
      } finally {
        escape.resolve();
        releaseCommand.resolve();
        await command;
        await innerClear;
        await outerClear;
        await clearActivePluginRegistry();
        if (db.isOpen) {
          db.close();
        }
        nativeState.database = undefined;
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect(nativeState.resets).toBe(1);
    },
  );

  it("retains a displaced loaded registry's cleanup through its admitted command", async () => {
    const { loadAndActivateRootPluginRegistry } = await import("./loader.js");
    const { resolvePluginLoadCacheContext } = await import("./loader-load-context.js");
    const { withPluginCommandExecution } = await import("./command-execution-lock.js");
    const { useNoBundledPlugins, writePlugin, resetPluginLoaderTestStateForTest } =
      await import("./loader.test-fixtures.js");
    useNoBundledPlugins();
    onTestFinished(resetPluginLoaderTestStateForTest);
    const db = new DatabaseSync(":memory:");
    const nativeState = resolveGlobalSingleton(
      Symbol.for("openclaw.test.actualPluginCleanupDatabase"),
      (): { database?: DatabaseSync; resets: number } => ({ resets: 0 }),
      (state) => {
        if (state.database?.isOpen) {
          state.resets++;
          state.database.close();
        }
      },
      "plugin-registry",
    );
    nativeState.database = db;
    nativeState.resets = 0;
    const reads: unknown[] = [];
    const bridge = resolveGlobalSingleton(
      Symbol.for("openclaw.test.loadedRetirementCleanup"),
      (): { read?: () => void } => ({}),
    );
    bridge.read = () => {
      reads.push(db.prepare("SELECT 1 AS value").get());
    };
    const plugin = writePlugin({
      id: "loaded-retirement",
      registration: `const read = globalThis[Symbol.for("openclaw.test.loadedRetirementCleanup")].read;
      api.lifecycle.registerRuntimeLifecycle({ id: "native-cleanup", cleanup: read });`,
    });
    const options = {
      config: {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          slots: { memory: "none" },
        },
      },
    };
    const original = createEmptyPluginRegistry();
    setActivePluginRegistry(original);
    const signal = capturePluginRegistryLifecycleSignal(
      original,
      capturePluginRegistryLifecycleEpoch(original),
    );
    if (!signal) {
      throw new Error("Expected an active predecessor signal");
    }
    const releaseCommand = createDeferredCore();
    let heldCommand: ReturnType<typeof withPluginCommandExecution> | undefined;
    let closing: Promise<void> | undefined;
    signal.addEventListener("abort", () => {
      const loaded = getActivePluginRegistry();
      if (loaded) {
        heldCommand = withPluginCommandExecution(loaded, () => releaseCommand.promise);
        closing = clearActivePluginRegistry();
      }
    });
    try {
      expect(() => loadAndActivateRootPluginRegistry(options)).toThrow(
        "Plugin registry activation was superseded",
      );
      expect(heldCommand).toBeDefined();
      expect(closing).toBeDefined();
      expect(db.isOpen).toBe(true);
      expect(reads).toEqual([]);
      const { cacheState, cacheKey } = resolvePluginLoadCacheContext(options);
      expect(cacheState.get(cacheKey)).toBeUndefined();
    } finally {
      releaseCommand.resolve();
      await heldCommand;
      await closing;
      await clearActivePluginRegistry();
      bridge.read = undefined;
      if (db.isOpen) {
        db.close();
      }
      nativeState.database = undefined;
    }
    expect(reads).toEqual([{ value: 1 }]);
    expect(nativeState.resets).toBe(1);
  });

  it.each(
    (["active", "replaced", "command-held"] as const).flatMap((lifetime) =>
      (["callback", "descendant"] as const).map((owner) => ({ lifetime, owner })),
    ),
  )(
    "joins $lifetime lifecycle $owner before plugin-registry resets",
    async ({ lifetime, owner }) => {
      const { createPluginRegistry } = await import("./registry.js");
      const { createPluginRuntime } = await import("./runtime/index.js");
      const { activatePluginRegistry } = await import("./loader-shared.js");
      const { withPluginCommandExecution, getPluginCommandExecutionCount } =
        await import("./command-execution-lock.js");
      const builder = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: createPluginRuntime(),
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({ id: "cleanup-sqlite", status: "loaded" });
      builder.registry.plugins.push(record);
      const api = builder.createApi(record, { config: {} });
      const db = new DatabaseSync(":memory:");
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore();
      const reads: unknown[] = [];
      const failures: unknown[] = [];
      const nativeState = resolveGlobalSingleton(
        Symbol.for("openclaw.test.actualPluginCleanupDatabase"),
        (): { database?: DatabaseSync; resets: number } => ({ resets: 0 }),
        (state) => {
          if (state.database?.isOpen) {
            state.resets++;
            state.database.close();
          }
        },
        "plugin-registry",
      );
      nativeState.database = db;
      nativeState.resets = 0;
      const readAfterRelease = async () => {
        entered.resolve();
        try {
          await release.promise;
          reads.push(db.prepare("SELECT 1 AS value").get());
        } catch (error) {
          failures.push(error);
        } finally {
          finished.resolve();
        }
      };
      const cleanup = vi.fn(() => {
        if (owner === "callback") {
          return readAfterRelease();
        }
        void trackAsyncWork(readAfterRelease);
        return undefined;
      });
      api.lifecycle.registerRuntimeLifecycle({ id: "held-cleanup", cleanup });
      setActivePluginRegistry(builder.registry);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const commandGate = createDeferredCore();
      const command =
        lifetime === "command-held"
          ? withPluginCommandExecution(builder.registry, () => commandGate.promise)
          : undefined;
      if (lifetime === "command-held") {
        expect(getPluginCommandExecutionCount(builder.registry)).toBe(1);
      }
      if (lifetime !== "active") {
        const replacement = createEmptyPluginRegistry();
        activatePluginRegistry(replacement, null, "default");
        expect(getActivePluginRegistry()).toBe(replacement);
        expect(await withPluginCommandExecution(builder.registry, () => undefined)).toEqual({
          admitted: false,
        });
        if (lifetime === "replaced") {
          await entered.promise;
        }
      }
      let closed = false;
      const closing = clearActivePluginRegistry().then(() => {
        closed = true;
      });
      try {
        if (lifetime === "command-held") {
          await vi.advanceTimersByTimeAsync(5000);
          expect(cleanup).not.toHaveBeenCalled();
          expect(db.isOpen).toBe(true);
          expect(closed).toBe(false);
          commandGate.resolve();
          expect(await command).toEqual({ admitted: true, value: undefined });
        }
        await entered.promise;
        await vi.advanceTimersByTimeAsync(5000);
        expect(getActivePluginRegistry()).toBeNull();
        expect(db.isOpen).toBe(true);
        expect(nativeState.resets).toBe(0);
        expect(closed).toBe(false);
      } finally {
        commandGate.resolve();
        release.resolve();
        await command;
        await finished.promise;
        await Promise.allSettled(cleanup.mock.results.map((result) => result.value));
        await closing;
        vi.useRealTimers();
        if (db.isOpen) {
          db.close();
        }
        nativeState.database = undefined;
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect(failures).toEqual([]);
      expect(reads).toEqual([{ value: 1 }]);
      expect(nativeState.resets).toBe(1);
    },
  );

  it("clears plugin host run contexts with the active registry", async () => {
    setPluginRunContext({
      pluginId: "runtime-test",
      patch: { runId: "run-1", namespace: "state", value: { ready: true } },
    });

    await clearActivePluginRegistry();

    expect(
      getPluginRunContext({
        pluginId: "runtime-test",
        get: { runId: "run-1", namespace: "state" },
      }),
    ).toBeUndefined();
  });
});
