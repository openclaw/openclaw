import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createContextEngineLogicalTurnLease as createLease } from "../agents/harness/context-engine-logical-turn.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import * as initialization from "./init.js";
import { LegacyContextEngine } from "./legacy.js";
import { createNativeSource } from "./registry-resources.test-support.js";
import * as contextEngineRegistry from "./registry.js";
import {
  adoptRuntimeContextEngineRegistrations,
  registerContextEngineInRegistry as registerEngine,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import type { ContextEngineFactory } from "./registry.js";
import type { ContextEngine } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it.each([
  "factory-tail",
  "abort-factory-tail",
  "dispose",
  "dispose-tail",
  "abort-tail",
  "parent-abort",
  "invalid-tail",
  "invalid-factory-tail",
  "factory-cleanup-error",
  "closing-factory",
  "last-user",
  "raw-view",
  "initialization",
  "initialization-error",
  "initialization-abort",
] as const)("retains the adopted engine's native source through %s", async (mode) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "context-engine-source-"));
  const databasePath = path.join(directory, "source.sqlite");
  const donor = createEmptyPluginRegistry();
  const supplyingView = createEmptyPluginRegistry();
  const viewSource = new PluginRegistryInspectionResources(retireInspectionInstances);
  const plugin = { id: "engine-source-fixture", source: path.join(directory, "plugin.cjs") };
  donor.plugins.push(createPluginRecord(plugin));
  supplyingView.plugins.push(createPluginRecord(plugin));
  if (mode !== "raw-view") {
    viewSource.attach(supplyingView);
  }
  const native = createNativeSource(databasePath, donor, plugin.id, () => {
    if (mode === "factory-cleanup-error") {
      throw new Error("registration disposer failed");
    }
  });
  const { database, resources: source } = native;
  const reads: number[] = [];
  const read = () => {
    try {
      reads.push(native.read());
    } catch {
      reads.push(-1);
    }
  };
  const factoryStarted = createDeferred();
  const factoryGate = createDeferred();
  const factoryTail = createDeferred();
  const disposeStarted = createDeferred();
  const disposeGate = createDeferred();
  const disposeTail = createDeferred();
  const tails: Promise<unknown>[] = [];
  const readAfter = (gate: { promise: PromiseLike<unknown> }, readValue = read) =>
    trackAsyncWork(async () => {
      await gate.promise;
      readValue();
    });
  const contexts: Array<string | undefined> = [];
  const signals: AbortSignal[] = [];
  let engineDisposals = 0;
  let cleanupSignal: AbortSignal | undefined;
  let factoryWorker: Promise<void> | undefined;
  let factoryWorkFinished = false;
  let abortInOrigin = false;
  class NativeEngine extends LegacyContextEngine {
    #read = read;
    override readonly info = {
      id: mode === "invalid-tail" || mode === "invalid-factory-tail" ? "" : "native-engine",
      name: "Native engine",
    };
    override async assemble(params: Parameters<ContextEngine["assemble"]>[0]) {
      this.#read();
      return await super.assemble(params);
    }
    async dispose() {
      engineDisposals++;
      disposeStarted.resolve();
      // A factory's accepted background work may require disposal to let it finish.
      if (mode !== "abort-factory-tail" && mode !== "invalid-factory-tail") {
        factoryTail.resolve();
      }
      if (mode === "invalid-factory-tail") {
        cleanupSignal = getAsyncWorkSignal();
        await factoryWorker;
      }
      if (mode === "dispose" || mode === "invalid-factory-tail") {
        await disposeGate.promise;
      }
      if (mode === "dispose-tail" || mode === "invalid-tail") {
        cleanupSignal = getAsyncWorkSignal();
        tails.push(readAfter(disposeTail, () => this.#read()));
      }
      this.#read();
    }
  }
  const factory: ContextEngineFactory = async (context) => {
    contexts.push(context.agentDir);
    const signal = getAsyncWorkSignal();
    if (signal) {
      signals.push(signal);
      if (mode === "abort-tail" || mode === "parent-abort") {
        signal.addEventListener(
          "abort",
          () => {
            abortInOrigin = getAsyncWorkSignal() === signal;
            tails.push(readAfter(disposeTail));
          },
          { once: true },
        );
      }
    }
    factoryStarted.resolve();
    if (mode === "closing-factory" || mode === "factory-cleanup-error") {
      await factoryGate.promise;
    }
    if (mode === "factory-tail" || mode === "closing-factory") {
      const tail = readAfter(factoryTail);
      void tail.catch(() => {});
      tails.push(tail);
    }
    if (mode === "abort-factory-tail" || mode === "invalid-factory-tail") {
      if (!signal) {
        throw new Error("Managed factory did not receive its work signal");
      }
      const stopped = createDeferred();
      signal.addEventListener("abort", () => stopped.resolve(), { once: true });
      factoryWorker = trackAsyncWork(async () => {
        await Promise.race([stopped.promise, factoryTail.promise]);
        read();
        factoryWorkFinished = true;
      });
      tails.push(factoryWorker);
    }
    read();
    if (mode === "closing-factory" || mode === "factory-cleanup-error") {
      throw new Error("original factory failure");
    }
    return new NativeEngine();
  };
  source.runRegistration(plugin.id, () => {
    registerEngine(donor, "selected", factory, `plugin:${plugin.id}`);
  });
  const copiedView = adoptRuntimeContextEngineRegistrations(supplyingView, donor);
  if (mode !== "raw-view") {
    viewSource.attach(copiedView);
  }
  const config = {
    plugins: { entries: { [plugin.id]: { enabled: true } }, slots: { contextEngine: "selected" } },
  };
  const cleanupScope = createAgentCleanupScope();
  const parent = new AsyncWorkScope();
  const foreign = new AsyncWorkScope();
  const leases: Array<Awaited<ReturnType<typeof createLease>>> = [];
  const pending: Array<Promise<unknown>> = [];
  const initializationStarted = createDeferred();
  const initializationGate = createDeferred();
  const initialize = initialization.ensureContextEnginesInitialized;
  const initializeSpy =
    mode === "initialization" || mode === "initialization-error" || mode === "initialization-abort"
      ? vi.spyOn(initialization, "ensureContextEnginesInitialized").mockImplementation(async () => {
          await initialize();
          initializationStarted.resolve();
          await initializationGate.promise;
        })
      : undefined;
  const start = async () => {
    const create = () =>
      cleanupScope.run(() =>
        withRegistry(copiedView, () =>
          createLease({
            identity: { runId: "fixture-run", sessionId: "fixture-session" },
            config,
            agentDir: path.join(directory, "staged-agent"),
            workspaceDir: path.join(directory, "workspace"),
          }),
        ),
      );
    const lease = await (mode === "abort-factory-tail" || mode === "invalid-factory-tail"
      ? create()
      : mode === "closing-factory"
        ? parent.run(create)
        : parent.track(create));
    leases.push(lease);
    return lease;
  };
  const first = start();
  pending.push(first);
  try {
    if (initializeSpy) {
      await source.release();
      await initializationStarted.promise;
      expect(database.isOpen).toBe(true);
      expect(contexts).toEqual([]);
      if (mode === "initialization-error" || mode === "initialization-abort") {
        const failure = new Error("initialization failed");
        if (mode === "initialization-error") {
          initializationGate.reject(failure);
        } else {
          parent.beginClose(failure);
          initializationGate.resolve();
        }
        await expect(first).rejects.toBe(failure);
        await parent.drain();
        expect(native.state).toMatchObject({ disposals: 1, open: false });
        expect(engineDisposals).toBe(0);
        return;
      }
      const replacement = vi.fn(() => new LegacyContextEngine());
      registerEngine(copiedView, "selected", replacement, `plugin:${plugin.id}`, {
        allowSameOwnerRefresh: true,
      });
      initializationGate.resolve();
      await first;
      expect(replacement).not.toHaveBeenCalled();
    }
    await factoryStarted.promise;
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    if (mode === "invalid-factory-tail") {
      await disposeStarted.promise;
    }
    if (mode === "last-user") {
      await first;
      await start();
    }
    await source.release();
    expect.soft(native.state).toMatchObject({ open: true, disposals: 0 });
    if (mode === "closing-factory") {
      let parentDrained = false;
      pending.push(
        parent.drain().then(() => {
          parentDrained = true;
        }),
      );
      await Promise.resolve();
      expect.soft(parentDrained).toBe(false);
    }
    if (mode === "invalid-factory-tail") {
      await nextEventLoopTurn();
      expect.soft(signals.every((signal) => signal.aborted)).toBe(true);
      expect.soft(factoryWorkFinished).toBe(true);
      expect.soft(cleanupSignal?.aborted).toBe(false);
      factoryTail.resolve();
      disposeGate.resolve();
    }
    factoryGate.resolve();
    const lease = await first;
    expect(contexts.every((value) => value === path.join(directory, "staged-agent"))).toBe(true);
    if (mode === "closing-factory" || mode === "factory-cleanup-error") {
      expect(lease.degradedReason).toBe("original factory failure");
      factoryTail.resolve();
    } else if (mode === "invalid-tail" || mode === "invalid-factory-tail") {
      expect(lease.degradedReason).toContain("missing info.id");
    } else {
      await lease.engine.assemble({ sessionId: "fixture-session", messages: [] });
    }
    if (mode === "parent-abort") {
      const reason = new Error("original parent abort");
      foreign.run(() => parent.beginClose(reason));
      expect(signals.every((signal) => signal.reason === reason)).toBe(true);
      let foreignDrained = false;
      pending.push(
        foreign.drain().then(() => {
          foreignDrained = true;
        }),
      );
      await nextEventLoopTurn();
      expect.soft(foreignDrained).toBe(true);
    }
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
    const cleanup = cleanupScope.run(() => lease.dispose());
    pending.push(cleanup);
    await vi.advanceTimersByTimeAsync(25);
    await cleanup;
    if (
      mode === "dispose" ||
      mode === "dispose-tail" ||
      mode === "abort-tail" ||
      mode === "parent-abort"
    ) {
      expect.soft(cleanupScope.outcome).toBe("uncertain");
      expect.soft(database.isOpen).toBe(true);
    }
    if (mode === "abort-tail" || mode === "parent-abort") {
      expect.soft(abortInOrigin).toBe(true);
    }
    if (mode === "last-user") {
      expect.soft(native.state.disposals).toBe(0);
      await leases[1]!.dispose();
    }
    if (mode === "dispose-tail" || mode === "invalid-tail") {
      expect.soft(cleanupSignal?.aborted).toBe(false);
    }
    if (mode === "abort-factory-tail") {
      expect.soft(cleanupScope.outcome).toBe("closed");
      factoryTail.resolve();
    }
    disposeGate.resolve();
    disposeTail.resolve();
    const settledTails = await Promise.allSettled(tails);
    expect.soft(settledTails.every((tail) => tail.status === "fulfilled")).toBe(true);
    await parent.drain();
    await native.disposed.promise;
    expect(native.state).toMatchObject({ disposals: 1, open: false });
    if (mode === "factory-cleanup-error") {
      expect.soft(cleanupScope.outcome).toBe("uncertain");
    }
    expect(reads.length).toBeGreaterThan(0);
    expect.soft(reads.every((value) => value === 42)).toBe(true);
    expect(engineDisposals).toBe(
      mode === "closing-factory" || mode === "factory-cleanup-error"
        ? 0
        : mode === "last-user"
          ? 2
          : 1,
    );
    await lease.dispose();
    const reopened = new DatabaseSync(databasePath);
    expect(reopened.prepare("SELECT 42 AS value").get()?.value).toBe(42);
    reopened.close();
  } finally {
    vi.useRealTimers();
    initializationGate.resolve();
    factoryGate.resolve();
    factoryTail.resolve();
    disposeGate.resolve();
    disposeTail.resolve();
    await Promise.allSettled(pending);
    await Promise.allSettled(leases.map((lease) => lease.dispose()));
    await Promise.allSettled(tails);
    await parent.drain();
    await foreign.drain();
    await source.release();
    await viewSource.release();
    initializeSpy?.mockRestore();
    if (database.isOpen) {
      database.close();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("disposes a shared engine once while releasing both factory source claims", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "context-engine-alias-"));
  const native = createNativeSource(path.join(directory, "source.sqlite"));
  const { database, registry, resources } = native;
  const finishTail = createDeferred();
  const tails: Promise<unknown>[] = [];
  let engineDisposals = 0;
  const reads: number[] = [];
  class SharedEngine extends LegacyContextEngine {
    #read = native.read;
    async dispose() {
      engineDisposals++;
      tails.push(
        trackAsyncWork(async () => {
          await finishTail.promise;
          try {
            reads.push(this.#read());
          } catch {
            reads.push(-1);
          }
        }),
      );
    }
  }
  const engine = new SharedEngine();
  resources.runRegistration("fixture", () => {
    registerEngine(registry, "legacy", () => engine, "core");
    registerEngine(registry, "selected", () => engine, "plugin:fixture");
  });
  const config = {
    plugins: { entries: { fixture: { enabled: true } }, slots: { contextEngine: "selected" } },
  };
  const resolution = await withRegistry(registry, () => resolveLogicalTurnContextEngines(config));
  // Feed the actual acquired pair to its existing logical owner without replacing the factories.
  const resolve = vi
    .spyOn(contextEngineRegistry, "resolveLogicalTurnContextEngines")
    .mockResolvedValueOnce(resolution);
  const lease = await withRegistry(registry, () =>
    createLease({
      identity: { runId: "alias-run", sessionId: "alias-session" },
      config,
    }),
  );
  let cleanup: Promise<void> | undefined;
  try {
    await resources.release();
    expect.soft(database.isOpen).toBe(true);
    vi.useFakeTimers();
    vi.stubEnv("OPENCLAW_AGENT_CLEANUP_TIMEOUT_MS", "25");
    cleanup = lease.dispose();
    await vi.advanceTimersByTimeAsync(25);
    await cleanup;
    expect.soft(engineDisposals).toBe(1);
    expect.soft(native.state.disposals).toBe(0);
    finishTail.resolve();
    await Promise.allSettled(tails);
    await native.disposed.promise;
    expect.soft(reads).toEqual([42]);
    expect(native.state).toMatchObject({ disposals: 1, open: false });
  } finally {
    finishTail.resolve();
    await Promise.allSettled(tails);
    await cleanup;
    await lease.dispose();
    await resources.release();
    resolve.mockRestore();
    vi.useRealTimers();
    if (database.isOpen) {
      database.close();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
