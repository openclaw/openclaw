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
} from "./registry-lifecycle.js";
import { getPluginRegistryState } from "./runtime-state.js";
import {
  captureActivePluginRegistrySnapshot,
  clearActivePluginRegistry,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  listImportedRuntimePluginIds,
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

function createCleanupDatabase() {
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
  const close = () => {
    if (db.isOpen) {
      db.close();
    }
    nativeState.database = undefined;
  };
  return { db, nativeState, close };
}

async function createDatabaseLifecycle(id: string) {
  const { createPluginRegistry } = await import("./registry.js");
  const { createPluginRuntime } = await import("./runtime/index.js");
  const execution = await import("./command-execution-lock.js");
  const { activatePluginRegistry } = await import("./loader-shared.js");
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntime(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id });
  builder.registry.plugins.push(record);
  return {
    registry: builder.registry,
    lifecycle: builder.createApi(record, { config: {} }).lifecycle,
    activatePluginRegistry,
    ...execution,
    ...createCleanupDatabase(),
  };
}

function attachLifecycle(
  registry: ReturnType<typeof createEmptyPluginRegistry>,
  id: string,
  cleanup: () => void | Promise<void>,
) {
  registry.runtimeLifecycles.push({
    pluginId: id,
    source: `/virtual/${id}/index.ts`,
    lifecycle: { id, cleanup },
  });
}

describe("setActivePluginRegistry", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
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
      createPluginRecord({ id: "bundle-only", format: "bundle" }),
      createPluginRecord({ id: "runtime-plugin", format: "openclaw" }),
    );

    setActivePluginRegistry(registry);

    expect(listImportedRuntimePluginIds()).toEqual(["runtime-plugin"]);
  });

  it.each([true, false])(
    "continues cleanup when refreshing the same registry: %s",
    async (same) => {
      const firstCleanupStarted = createDeferredCore();
      const firstCleanupReleased = createDeferredCore();
      const secondCleanupCalled = createDeferredCore();
      onTestFinished(() => firstCleanupReleased.resolve());
      const previous = createEmptyPluginRegistry();
      previous.plugins.push(createPluginRecord({ id: "cleanup-refresh-race" }));
      previous.runtimeLifecycles = [
        {
          id: "first-cleanup",
          async cleanup() {
            firstCleanupStarted.resolve();
            await firstCleanupReleased.promise;
          },
        },
        {
          id: "second-cleanup",
          cleanup() {
            secondCleanupCalled.resolve();
          },
        },
      ].map((lifecycle) => ({
        pluginId: "cleanup-refresh-race",
        pluginName: "Cleanup Refresh Race",
        lifecycle,
        source: "/virtual/cleanup-refresh-race/index.ts",
        rootDir: "/virtual/cleanup-refresh-race",
      }));
      const next = createEmptyPluginRegistry();

      setActivePluginRegistry(previous);
      setActivePluginRegistry(next);
      // The race starts inside cleanup; cold lazy imports are not a cleanup deadline.
      await firstCleanupStarted.promise;

      setActivePluginRegistry(same ? next : createEmptyPluginRegistry());
      firstCleanupReleased.resolve();

      await waitForCleanupSignal(secondCleanupCalled.promise, "second cleanup");
    },
  );

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

  it("joins a displaced cleanup scope created before package replacement", async () => {
    const registry = createEmptyPluginRegistry();
    const entered = createDeferredCore();
    const finish = createDeferredCore();
    attachLifecycle(registry, "released-scope", async () => {
      entered.resolve();
      await finish.promise;
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
        attachLifecycle(registry, "reentrant-cleanup", cleanup);
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

  it.each(["install", "staged", "clear"] as const)(
    "keeps an admitted command live through a reentrant retirement abort (%s)",
    async (retirement) => {
      const fixture = await createDatabaseLifecycle("abort-cleanup-sqlite");
      const { registry, lifecycle, db, nativeState, close } = fixture;
      const cleanup = vi.fn(() => {
        expect(db.prepare("SELECT 2 AS value").get()).toEqual({ value: 2 });
      });
      lifecycle.registerRuntimeLifecycle({ id: "abort-cleanup", cleanup });
      setActivePluginRegistry(registry);
      const successor = createEmptyPluginRegistry();
      const signal = capturePluginRegistryLifecycleSignal(
        registry,
        capturePluginRegistryLifecycleEpoch(registry),
      );
      if (!signal) {
        throw new Error("Expected an active registry lifecycle signal");
      }
      let innerClear: Promise<void> | undefined;
      let outerClear: Promise<void> | undefined;
      signal.addEventListener("abort", () => {
        innerClear = clearActivePluginRegistry();
      });
      const escape = createDeferredCore();
      const commandRead = createDeferredCore();
      const releaseCommand = createDeferredCore();
      const reads: unknown[] = [];
      const failures: unknown[] = [];
      const command = fixture.withPluginCommandExecution(registry, async () => {
        if (retirement === "clear") {
          outerClear = clearActivePluginRegistry();
        } else if (retirement === "staged") {
          fixture.activatePluginRegistry(successor, "successor", "explicit", "/virtual/successor");
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
        expect(captureActivePluginRegistrySnapshot()).toEqual({
          activeRegistry: null,
          key: null,
          workspaceDir: null,
          runtimeSubagentMode: "default",
        });
      } finally {
        escape.resolve();
        releaseCommand.resolve();
        await command;
        await innerClear;
        await outerClear;
        await clearActivePluginRegistry();
        close();
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect(nativeState.resets).toBe(1);
    },
  );

  it.each(
    (["active", "replaced", "command-held"] as const).flatMap((lifetime) =>
      (["callback", "descendant"] as const).map((owner) => ({ lifetime, owner })),
    ),
  )(
    "joins $lifetime lifecycle $owner before plugin-registry resets",
    async ({ lifetime, owner }) => {
      const fixture = await createDatabaseLifecycle("cleanup-sqlite");
      const { registry, lifecycle, db, nativeState, close } = fixture;
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore();
      const reads: unknown[] = [];
      const failures: unknown[] = [];
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
      lifecycle.registerRuntimeLifecycle({ id: "held-cleanup", cleanup });
      setActivePluginRegistry(registry);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const commandGate = createDeferredCore();
      const command =
        lifetime === "command-held"
          ? fixture.withPluginCommandExecution(registry, () => commandGate.promise)
          : undefined;
      if (lifetime === "command-held") {
        expect(fixture.getPluginCommandExecutionCount(registry)).toBe(1);
      }
      if (lifetime !== "active") {
        const replacement = createEmptyPluginRegistry();
        fixture.activatePluginRegistry(replacement, null, "default");
        expect(getActivePluginRegistry()).toBe(replacement);
        expect(await fixture.withPluginCommandExecution(registry, () => undefined)).toEqual({
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
        close();
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
