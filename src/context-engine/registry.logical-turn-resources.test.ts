import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createContextEngineLogicalTurnLease } from "../agents/harness/context-engine-logical-turn.js";
import { createAgentCleanupScope } from "../agents/run-cleanup-timeout.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { LegacyContextEngine } from "./legacy.js";
import * as contextEngineRegistry from "./registry.js";
import {
  adoptRuntimeContextEngineRegistrations,
  registerContextEngineInRegistry,
  resolveLogicalTurnContextEngines,
} from "./registry.js";
import type { ContextEngineFactory } from "./registry.js";
import type { ContextEngine } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("captures configured registration before awaiting the fallback factory", async () => {
  const registry = createEmptyPluginRegistry();
  const fallbackGate = createDeferred();
  const calls: string[] = [];
  const factory =
    (name: string): ContextEngineFactory =>
    () => {
      calls.push(name);
      return new LegacyContextEngine();
    };
  registerContextEngineInRegistry(
    registry,
    "legacy",
    async () => {
      await fallbackGate.promise;
      return new LegacyContextEngine();
    },
    "core",
  );
  registerContextEngineInRegistry(registry, "selected", factory("original"), "plugin:fixture");
  const pending = withPluginRuntimeRegistryScope(registry, () =>
    resolveLogicalTurnContextEngines({ plugins: { slots: { contextEngine: "selected" } } }),
  );
  registerContextEngineInRegistry(registry, "selected", factory("replacement"), "plugin:fixture", {
    allowSameOwnerRefresh: true,
  });
  fallbackGate.resolve();
  const resolved = await pending;
  expect(calls).toEqual(["original"]);
  await resolved.configured.engine.dispose?.();
  await resolved.fallback.engine.dispose?.();
});

it.each([
  "selection",
  "factory",
  "factory-tail",
  "abort-factory-tail",
  "dispose",
  "dispose-tail",
  "abort-tail",
  "parent-abort",
  "invalid",
  "invalid-tail",
  "invalid-factory-tail",
  "factory-error",
  "factory-cleanup-error",
  "closing-factory",
  "last-user",
  "raw",
  "raw-view",
] as const)("retains the adopted engine's native source through %s", async (mode) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "context-engine-source-"));
  const databasePath = path.join(directory, "source.sqlite");
  const database = new DatabaseSync(databasePath);
  const source = new PluginRegistryInspectionResources();
  const donor = createEmptyPluginRegistry();
  const supplyingView = createEmptyPluginRegistry();
  const viewSource = new PluginRegistryInspectionResources();
  const plugin = { id: "engine-source-fixture", source: path.join(directory, "plugin.cjs") };
  donor.plugins.push(createPluginRecord(plugin));
  supplyingView.plugins.push(createPluginRecord(plugin));
  if (mode !== "raw") {
    source.attach(donor);
  }
  if (mode !== "raw-view") {
    viewSource.attach(supplyingView);
  }
  let sourceDisposals = 0;
  const sourceDisposed = createDeferred();
  source.register(plugin.id, {
    id: "native",
    dispose() {
      sourceDisposals++;
      database.close();
      sourceDisposed.resolve();
      if (mode === "factory-cleanup-error") {
        throw new Error("registration disposer failed");
      }
    },
  });
  const reads: number[] = [];
  const read = () => {
    try {
      reads.push(Number(database.prepare("SELECT 42 AS value").get()?.value));
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
      id:
        mode === "invalid" || mode === "invalid-tail" || mode === "invalid-factory-tail"
          ? ""
          : "native-engine",
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
      if (mode === "dispose" || mode === "invalid" || mode === "invalid-factory-tail") {
        await disposeGate.promise;
      }
      if (mode === "dispose-tail" || mode === "invalid-tail") {
        cleanupSignal = getAsyncWorkSignal();
        tails.push(
          trackAsyncWork(async () => {
            await disposeTail.promise;
            this.#read();
          }),
        );
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
            tails.push(
              trackAsyncWork(async () => {
                await disposeTail.promise;
                read();
              }),
            );
          },
          { once: true },
        );
      }
    }
    factoryStarted.resolve();
    if (mode === "factory" || mode === "closing-factory" || mode === "factory-cleanup-error") {
      await factoryGate.promise;
    }
    if (mode === "factory-tail" || mode === "factory-error" || mode === "closing-factory") {
      const tail = trackAsyncWork(async () => {
        await factoryTail.promise;
        read();
      });
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
    if (
      mode === "factory-error" ||
      mode === "closing-factory" ||
      mode === "factory-cleanup-error"
    ) {
      throw new Error("original factory failure");
    }
    return new NativeEngine();
  };
  source.runRegistration(plugin.id, () => {
    registerContextEngineInRegistry(donor, "selected", factory, `plugin:${plugin.id}`);
  });
  const copiedView = adoptRuntimeContextEngineRegistrations(supplyingView, donor);
  if (mode !== "raw-view") {
    viewSource.attach(copiedView);
  }
  const config = { plugins: { slots: { contextEngine: "selected" } } };
  const cleanupScope = createAgentCleanupScope();
  const parent = new AsyncWorkScope();
  const foreign = new AsyncWorkScope();
  const leases: Array<Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>>> = [];
  const pending: Array<Promise<unknown>> = [];
  const start = async () => {
    const create = () =>
      cleanupScope.run(() =>
        withPluginRuntimeRegistryScope(copiedView, () =>
          createContextEngineLogicalTurnLease({
            identity: { runId: "fixture-run", sessionId: "fixture-session" },
            config,
            agentDir: path.join(directory, "staged-agent"),
            workspaceDir: path.join(directory, "workspace"),
            warn: () => {},
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
    if (mode === "selection") {
      await source.release();
    }
    await factoryStarted.promise;
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    if (mode === "invalid" || mode === "invalid-factory-tail") {
      await disposeStarted.promise;
    }
    if (mode === "last-user") {
      await first;
      await start();
    }
    if (mode !== "raw") {
      await source.release();
      expect.soft(database.isOpen).toBe(true);
      expect.soft(sourceDisposals).toBe(0);
    }
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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect.soft(signals.every((signal) => signal.aborted)).toBe(true);
      expect.soft(factoryWorkFinished).toBe(true);
      expect.soft(cleanupSignal?.aborted).toBe(false);
      factoryTail.resolve();
      disposeGate.resolve();
    }
    factoryGate.resolve();
    if (mode === "invalid") {
      disposeGate.resolve();
    }
    const lease = await first;
    expect(contexts.every((value) => value === path.join(directory, "staged-agent"))).toBe(true);
    if (
      mode === "factory-error" ||
      mode === "closing-factory" ||
      mode === "factory-cleanup-error"
    ) {
      expect(lease.degradedReason).toBe("original factory failure");
      factoryTail.resolve();
    } else if (mode === "invalid" || mode === "invalid-tail" || mode === "invalid-factory-tail") {
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
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
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
      expect.soft(sourceDisposals).toBe(0);
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
    if (mode !== "raw") {
      await sourceDisposed.promise;
      expect(sourceDisposals).toBe(1);
      expect(database.isOpen).toBe(false);
    } else {
      expect(database.isOpen).toBe(true);
      expect(sourceDisposals).toBe(0);
    }
    if (mode === "factory-cleanup-error") {
      expect.soft(cleanupScope.outcome).toBe("uncertain");
    }
    expect(reads.length).toBeGreaterThan(0);
    expect.soft(reads.every((value) => value === 42)).toBe(true);
    expect(engineDisposals).toBe(
      mode === "factory-error" || mode === "closing-factory" || mode === "factory-cleanup-error"
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
    if (database.isOpen) {
      database.close();
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("disposes a shared engine once while releasing both factory source claims", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "context-engine-alias-"));
  const database = new DatabaseSync(path.join(directory, "source.sqlite"));
  const registry = createEmptyPluginRegistry();
  const resources = new PluginRegistryInspectionResources();
  resources.attach(registry);
  const sourceDisposed = createDeferred();
  const finishTail = createDeferred();
  const tails: Promise<unknown>[] = [];
  let sourceDisposals = 0;
  let engineDisposals = 0;
  const reads: number[] = [];
  resources.register("fixture", {
    id: "native",
    dispose() {
      sourceDisposals++;
      database.close();
      sourceDisposed.resolve();
    },
  });
  class SharedEngine extends LegacyContextEngine {
    #database = database;
    async dispose() {
      engineDisposals++;
      tails.push(
        trackAsyncWork(async () => {
          await finishTail.promise;
          try {
            reads.push(Number(this.#database.prepare("SELECT 42 AS value").get()?.value));
          } catch {
            reads.push(-1);
          }
        }),
      );
    }
  }
  const engine = new SharedEngine();
  resources.runRegistration("fixture", () => {
    registerContextEngineInRegistry(registry, "legacy", () => engine, "core");
    registerContextEngineInRegistry(registry, "selected", () => engine, "plugin:fixture");
  });
  const config = { plugins: { slots: { contextEngine: "selected" } } };
  const resolution = await withPluginRuntimeRegistryScope(registry, () =>
    resolveLogicalTurnContextEngines(config),
  );
  // Feed the actual acquired pair to its existing logical owner without replacing the factories.
  const resolve = vi
    .spyOn(contextEngineRegistry, "resolveLogicalTurnContextEngines")
    .mockResolvedValueOnce(resolution);
  const lease = await withPluginRuntimeRegistryScope(registry, () =>
    createContextEngineLogicalTurnLease({
      identity: { runId: "alias-run", sessionId: "alias-session" },
      config,
      warn: () => {},
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
    expect.soft(sourceDisposals).toBe(0);
    finishTail.resolve();
    await Promise.allSettled(tails);
    await sourceDisposed.promise;
    expect.soft(reads).toEqual([42]);
    expect(sourceDisposals).toBe(1);
    expect(database.isOpen).toBe(false);
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
