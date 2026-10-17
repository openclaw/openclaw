import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
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

function heldWork(afterRelease = () => {}) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const finished = createDeferredCore();
  const run = async () => {
    entered.resolve();
    try {
      await release.promise;
      afterRelease();
    } finally {
      finished.resolve();
    }
  };
  return { entered, release, finished, run };
}

function createCleanupDatabase() {
  const db = new DatabaseSync(":memory:");
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
  const close = () => {
    if (db.isOpen) {
      db.close();
    }
    nativeState.database = undefined;
  };
  const read = () => {
    try {
      reads.push(db.prepare("SELECT 1 AS value").get());
    } catch (error) {
      failures.push(error);
    }
  };
  return { db, nativeState, close, read, reads, failures };
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
  lifecycleId = id,
) {
  registry.runtimeLifecycles.push({
    pluginId: id,
    source: `/virtual/${id}/index.ts`,
    lifecycle: { id: lifecycleId, cleanup },
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
      const first = heldWork();
      const secondCleanupCalled = createDeferredCore();
      onTestFinished(() => first.release.resolve());
      const previous = createEmptyPluginRegistry();
      previous.plugins.push(createPluginRecord({ id: "cleanup-refresh-race" }));
      attachLifecycle(previous, "cleanup-refresh-race", first.run, "first-cleanup");
      attachLifecycle(
        previous,
        "cleanup-refresh-race",
        () => secondCleanupCalled.resolve(),
        "second-cleanup",
      );
      const next = createEmptyPluginRegistry();

      setActivePluginRegistry(previous);
      setActivePluginRegistry(next);
      // The race starts inside cleanup; cold lazy imports are not a cleanup deadline.
      await first.entered.promise;

      setActivePluginRegistry(same ? next : createEmptyPluginRegistry());
      first.release.resolve();

      await withTestTimeout(secondCleanupCalled.promise, 500, "second cleanup");
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
      const cleaned = vi.fn();
      const held = heldWork(cleaned);
      const cleanup = () => trackAsyncWork(held.run);
      if (kind === "instance") {
        instance.lifecycle.onDispose(cleanup);
      } else {
        attachLifecycle(registry, record.id, cleanup, "tracked-store-close");
      }
      let retirement: ReturnType<typeof disposePluginRegistryInstances> | undefined;
      const request = owner.track(() => {
        retirement = disposePluginRegistryInstances(registry, undefined, {
          beforeDispose: () => initialize.promise,
        });
        void retirement.catch(() => {});
      });
      const disposeTerminalSessions = vi.fn();
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
        disposeTerminalSessions,
        close: async () => {
          await retirement;
        },
        onError,
      });
      try {
        await request;
        await nextTurn();
        expect(disposeTerminalSessions).not.toHaveBeenCalled();
        initialize.resolve();
        await held.entered.promise;
        await nextTurn();
        expect(disposeTerminalSessions).not.toHaveBeenCalled();
        held.release.resolve();
        await expect(retirement).resolves.toMatchObject({ failures: [] });
        await drain;
        expect(cleaned).toHaveBeenCalledOnce();
        expect(disposeTerminalSessions).toHaveBeenCalledOnce();
        expect(onError).not.toHaveBeenCalled();
        await expect(owner.track(() => undefined)).rejects.toThrow("Async work scope is closed");
      } finally {
        initialize.resolve();
        held.release.resolve();
        await Promise.allSettled([retirement, drain]);
      }
    },
  );

  it("joins a displaced cleanup scope created before package replacement", async () => {
    const registry = createEmptyPluginRegistry();
    const held = heldWork();
    attachLifecycle(registry, "released-scope", held.run);
    setActivePluginRegistry(registry);
    setActivePluginRegistry(createEmptyPluginRegistry());
    await held.entered.promise;
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
      held.release.resolve();
      await expect(closing).resolves.toBeUndefined();
      expect(getActivePluginRegistry()).toBeNull();
    } finally {
      held.release.resolve();
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
        await withTestTimeout(finished.promise, 500, "reentrant retired cleanup");
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
        fixture.read();
        commandRead.resolve();
        await releaseCommand.promise;
      });
      try {
        await withTestTimeout(commandRead.promise, 500, "command after retirement abort clear");
        expect([fixture.failures, fixture.reads]).toEqual([[], [{ value: 1 }]]);
        expect([db.isOpen, nativeState.resets]).toEqual([true, 0]);
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
      const held = heldWork(fixture.read);
      const cleanup = vi.fn(() => {
        if (owner === "callback") {
          return held.run();
        }
        void trackAsyncWork(held.run);
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
          await held.entered.promise;
        }
      }
      const closed = vi.fn();
      const closing = clearActivePluginRegistry().then(closed);
      try {
        if (lifetime === "command-held") {
          await vi.advanceTimersByTimeAsync(5000);
          expect(cleanup).not.toHaveBeenCalled();
          expect(db.isOpen).toBe(true);
          expect(closed).not.toHaveBeenCalled();
          commandGate.resolve();
          expect(await command).toEqual({ admitted: true, value: undefined });
        }
        await held.entered.promise;
        await vi.advanceTimersByTimeAsync(5000);
        expect(getActivePluginRegistry()).toBeNull();
        expect([db.isOpen, nativeState.resets]).toEqual([true, 0]);
        expect(closed).not.toHaveBeenCalled();
      } finally {
        commandGate.resolve();
        held.release.resolve();
        await command;
        await held.finished.promise;
        await Promise.allSettled(cleanup.mock.results.map((result) => result.value));
        await closing;
        vi.useRealTimers();
        close();
      }
      expect(cleanup).toHaveBeenCalledOnce();
      expect([fixture.failures, fixture.reads]).toEqual([[], [{ value: 1 }]]);
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
