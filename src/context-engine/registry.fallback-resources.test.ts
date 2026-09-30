import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { LegacyContextEngine } from "./legacy.js";
import * as health from "./quarantine-health.js";
import { registerContextEngineInRegistry, resolveContextEngine } from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

it.each([
  "ready",
  "pending",
  "rejected-factory",
  "primary-failure",
  "fallback-failure",
  "shared",
  "legacy",
  "unused",
] as const)("releases foreground factory resources after lazy fallback (%s)", async (mode) => {
  const registry = createEmptyPluginRegistry();
  const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
  resources.attach(registry);
  const database = new DatabaseSync(":memory:");
  let sourceDisposals = 0;
  resources.register("fixture", {
    id: "native",
    dispose() {
      sourceDisposals++;
      database.close();
    },
  });
  const fallbackStarted = createDeferred();
  const fallbackGate = createDeferred();
  const cleanupGate = createDeferred();
  const factoryFailure = new Error("fallback factory failed");
  let rawCleanup: Promise<void> | undefined;
  const cleanupReads: number[] = [];
  const primaryFailure = new Error("configured cleanup failed");
  const fallbackFailure = new Error("fallback cleanup failed");
  let primaryDisposals = 0;
  let fallbackDisposals = 0;
  let fallbackFactories = 0;
  let fallbackClosedAfterDisposalStarted: boolean | undefined;
  let primaryCalls = 0;
  class SelectedEngine extends LegacyContextEngine {
    override async assemble(params: Parameters<ContextEngine["assemble"]>[0]) {
      if (++primaryCalls === 1 || mode !== "shared") {
        throw new Error("configured store unavailable");
      }
      return await super.assemble(params);
    }
    async dispose() {
      primaryDisposals++;
      expect(database.prepare("SELECT 42 AS value").get()?.value).toBe(42);
      if (mode === "primary-failure") {
        throw primaryFailure;
      }
    }
  }
  class FallbackEngine extends LegacyContextEngine {
    async dispose() {
      fallbackDisposals++;
      expect(database.prepare("SELECT 42 AS value").get()?.value).toBe(42);
      if (mode === "fallback-failure") {
        throw fallbackFailure;
      }
    }
  }
  const primary = new SelectedEngine();
  registerContextEngineInRegistry(
    registry,
    "legacy",
    async () => {
      fallbackFactories++;
      getAsyncWorkSignal()?.addEventListener(
        "abort",
        () => {
          fallbackClosedAfterDisposalStarted =
            (mode === "shared" ? primaryDisposals : fallbackDisposals) > 0;
        },
        { once: true },
      );
      fallbackStarted.resolve();
      if (mode === "rejected-factory") {
        rawCleanup = trackAsyncWork(async () => {
          await cleanupGate.promise;
          cleanupReads.push(Number(database.prepare("SELECT 42 AS value").get()?.value));
        });
      }
      if (mode === "pending" || mode === "rejected-factory") {
        await fallbackGate.promise;
      }
      if (mode === "rejected-factory") {
        throw factoryFailure;
      }
      return mode === "shared"
        ? primary
        : mode === "legacy"
          ? new LegacyContextEngine()
          : new FallbackEngine();
    },
    "core",
  );
  const selectedId = `fallback-resources-${mode}`;
  registerContextEngineInRegistry(registry, selectedId, () => primary, "plugin:fixture");
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  const params = { sessionId: "fallback-session", messages: [] };
  let engine: ContextEngine | undefined;
  let operation: Promise<unknown> | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    engine = await withPluginRuntimeRegistryScope(registry, () =>
      resolveContextEngine({
        plugins: { entries: { fixture: { enabled: true } }, slots: { contextEngine: selectedId } },
      }),
    );
    if (mode !== "unused") {
      operation = withPluginRuntimeRegistryScope(registry, () => engine!.assemble(params));
      if (mode === "rejected-factory") {
        operation = expect(operation).rejects.toThrow("configured store unavailable");
      }
      await fallbackStarted.promise;
      if (mode !== "pending" && mode !== "rejected-factory") {
        await operation;
      }
    }
    await resources.release();
    let settled = false;
    cleanup = Promise.resolve(engine.dispose?.()).finally(() => {
      settled = true;
    });
    const outcome = cleanup.then(
      () => undefined,
      (error: unknown) => error,
    );
    if (mode === "pending" || mode === "rejected-factory") {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect.soft(settled).toBe(false);
      expect.soft(database.isOpen).toBe(true);
      fallbackGate.resolve();
      await operation;
      if (mode === "rejected-factory") {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(settled).toBe(false);
        expect.soft(database.isOpen).toBe(true);
        cleanupGate.resolve();
        await rawCleanup;
      }
    }
    expect(await outcome).toBe(
      mode === "primary-failure"
        ? primaryFailure
        : mode === "fallback-failure"
          ? fallbackFailure
          : mode === "rejected-factory"
            ? factoryFailure
            : undefined,
    );
    expect.soft(primaryDisposals).toBe(1);
    expect
      .soft(fallbackDisposals)
      .toBe(
        mode === "shared" || mode === "legacy" || mode === "unused" || mode === "rejected-factory"
          ? 0
          : 1,
      );
    if (mode === "rejected-factory") {
      expect(cleanupReads).toEqual([42]);
    }
    if (mode !== "legacy" && mode !== "unused" && mode !== "rejected-factory") {
      expect.soft(fallbackClosedAfterDisposalStarted).toBe(true);
    }
    expect.soft(sourceDisposals).toBe(1);
    expect.soft(database.isOpen).toBe(false);
    await Promise.resolve(engine.dispose?.()).catch(() => {});
    expect.soft(primaryDisposals).toBe(1);
    // A saved ordinary method cannot reopen the lazy factory after its owner closes.
    await expect(
      withPluginRuntimeRegistryScope(registry, () => engine!.assemble(params)),
    ).rejects.toThrow();
    expect(fallbackFactories).toBe(mode === "unused" ? 0 : 1);
  } finally {
    fallbackGate.resolve();
    cleanupGate.resolve();
    await rawCleanup;
    await operation?.catch(() => {});
    await cleanup?.catch(() => {});
    await resources.release();
    if (database.isOpen) {
      database.close();
    }
    warn.mockRestore();
  }
});

it.each(["missing", "factory", "guarded"] as const)(
  "retains a distinct fallback source while recording quarantine (%s)",
  async (mode) => {
    const donor = createEmptyPluginRegistry();
    const registry = createEmptyPluginRegistry();
    const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
    resources.attach(donor);
    const database = new DatabaseSync(":memory:");
    let sourceDisposals = 0;
    resources.register("fallback", {
      id: "native",
      dispose() {
        sourceDisposals++;
        database.close();
      },
    });
    const fallback = vi.fn(() => {
      expect(database.prepare("SELECT 42 AS value").get()?.value).toBe(42);
      return new LegacyContextEngine();
    });
    registerContextEngineInRegistry(donor, "legacy", fallback, "core");
    // A copied registration still belongs to the donor, not this unowned view.
    registry.contextEngines.set("legacy", donor.contextEngines.get("legacy")!);
    const id = `quarantine-source-${mode}`;
    const failure = new Error("configured engine failed");
    if (mode !== "missing") {
      registerContextEngineInRegistry(
        registry,
        id,
        () => {
          if (mode === "factory") {
            throw failure;
          }
          return Object.assign(new LegacyContextEngine(), {
            assemble: async () => {
              throw failure;
            },
          });
        },
        "plugin:fixture",
      );
    }
    const started = createDeferred();
    const gate = createDeferred();
    const record = health.recordPersistedContextEngineQuarantine;
    const recording = vi
      .spyOn(health, "recordPersistedContextEngineQuarantine")
      .mockImplementation(async (...args) => {
        started.resolve();
        await gate.promise;
        await record(...args);
      });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    let engine: ContextEngine | undefined;
    let operation: Promise<unknown> | undefined;
    try {
      const resolve = () =>
        withPluginRuntimeRegistryScope(registry, () =>
          resolveContextEngine({
            plugins: { entries: { fixture: { enabled: true } }, slots: { contextEngine: id } },
          }),
        );
      if (mode === "guarded") {
        engine = await resolve();
        operation = withPluginRuntimeRegistryScope(registry, () =>
          engine!.assemble({ sessionId: "recording-source", messages: [] }),
        );
      } else {
        operation = resolve().then((resolved) => {
          engine = resolved;
        });
      }
      void operation.catch(() => {});
      await started.promise;
      await resources.release();
      expect(database.isOpen).toBe(true);
      expect(sourceDisposals).toBe(0);
      expect(fallback).not.toHaveBeenCalled();
      const replacement = vi.fn(() => new LegacyContextEngine());
      registerContextEngineInRegistry(registry, "legacy", replacement, "core", {
        allowSameOwnerRefresh: true,
      });
      gate.resolve();
      await operation;
      expect(fallback).toHaveBeenCalledOnce();
      expect(replacement).not.toHaveBeenCalled();
      await engine?.dispose?.();
      expect(sourceDisposals).toBe(1);
      expect(database.isOpen).toBe(false);
    } finally {
      gate.resolve();
      await operation?.catch(() => {});
      await engine?.dispose?.();
      await resources.release();
      if (database.isOpen) {
        database.close();
      }
      recording.mockRestore();
      warn.mockRestore();
      await resetContextEngineRuntimeQuarantineForTests();
    }
  },
);
