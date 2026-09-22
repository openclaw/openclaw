import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { PluginRegistryInspectionResources } from "../plugins/registry-inspection-resources.js";
import { retireInspectionInstances } from "../plugins/registry-inspection.test-support.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { LegacyContextEngine } from "./legacy.js";
import {
  listContextEngineQuarantines,
  registerContextEngineInRegistry,
  resolveContextEngine,
} from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests } from "./registry.test-support.js";

beforeEach(() => resetContextEngineRuntimeQuarantineForTests());

afterEach(() => {
  resetContextEngineRuntimeQuarantineForTests();
  vi.restoreAllMocks();
});

it.each(["closed-scope", "released-source"] as const)(
  "propagates host admission failure without quarantining an uncalled factory (%s)",
  async (mode) => {
    const registry = createEmptyPluginRegistry();
    const selectedId = `admission-${mode}`;
    const configuredFactory = vi.fn(() => new LegacyContextEngine());
    const fallbackFactory = vi.fn(() => new LegacyContextEngine());
    const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
    const retire = vi.fn();
    resources.attach(registry);
    resources.register("fixture", { id: "resource", dispose: retire });
    registerContextEngineInRegistry(registry, selectedId, configuredFactory, "plugin:fixture");
    registerContextEngineInRegistry(registry, "legacy", fallbackFactory, "core");
    const resolve = () =>
      withPluginRuntimeRegistryScope(registry, () =>
        resolveContextEngine({ plugins: { slots: { contextEngine: selectedId } } }),
      );
    const work = new AsyncWorkScope();
    const continuation = work.run(() => AsyncLocalStorage.snapshot());
    await work.drain();
    if (mode === "released-source") {
      await resources.release();
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(mode === "closed-scope" ? continuation(resolve) : resolve()).rejects.toThrow(
        mode === "closed-scope"
          ? "Async work scope is closed"
          : "Plugin inspection resources have been released",
      );
      expect(configuredFactory).not.toHaveBeenCalled();
      expect(fallbackFactory).not.toHaveBeenCalled();
      expect(listContextEngineQuarantines()).toEqual([]);
      expect(log).not.toHaveBeenCalled();
      if (mode === "closed-scope") {
        // The same registration remains usable by a fresh caller, without reactivation.
        const engine = await resolve();
        expect(configuredFactory).toHaveBeenCalledOnce();
        expect(fallbackFactory).not.toHaveBeenCalled();
        await resources.release();
        expect(retire).not.toHaveBeenCalled();
        await engine.dispose?.();
      }
    } finally {
      await resources.release();
    }
    expect(retire).toHaveBeenCalledOnce();
  },
);

it("still quarantines a factory that itself throws the host admission error text", async () => {
  const registry = createEmptyPluginRegistry();
  const selectedId = "factory-admission-text";
  const factory = vi.fn(() => {
    throw new Error("Async work scope is closed");
  });
  registerContextEngineInRegistry(registry, selectedId, factory, "plugin:fixture");
  registerContextEngineInRegistry(registry, "legacy", () => new LegacyContextEngine(), "core");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const resolve = () =>
    withPluginRuntimeRegistryScope(registry, () =>
      resolveContextEngine({ plugins: { slots: { contextEngine: selectedId } } }),
    );
  expect((await resolve()).info.id).toBe("legacy");
  expect((await resolve()).info.id).toBe("legacy");
  expect(factory).toHaveBeenCalledOnce();
  expect(listContextEngineQuarantines()).toEqual([
    expect.objectContaining({ engineId: selectedId, operation: "factory" }),
  ]);
});

it.each(["reason", "wrapped-reason", "abort-error", "unrelated-error"] as const)(
  "distinguishes factory cancellation from plugin failure (%s)",
  async (mode) => {
    const registry = createEmptyPluginRegistry();
    const resources = new PluginRegistryInspectionResources(retireInspectionInstances);
    resources.attach(registry);
    const retired = vi.fn();
    resources.register("fixture", { id: "factory-resource", dispose: retired });
    const started = createDeferred();
    const fail = createDeferred();
    const cleanupGate = createDeferred();
    const owner = new AsyncWorkScope();
    const reason = new Error("host request cancelled");
    const failure =
      mode === "reason"
        ? reason
        : mode === "wrapped-reason"
          ? new Error("factory interrupted", { cause: reason })
          : mode === "abort-error"
            ? new DOMException("factory interrupted", "AbortError")
            : new Error("independent factory defect");
    const fallback = vi.fn(() => new LegacyContextEngine());
    registerContextEngineInRegistry(registry, "legacy", fallback, "core");
    registerContextEngineInRegistry(
      registry,
      "cancelled-factory",
      async () => {
        void trackAsyncWork(() => cleanupGate.promise);
        const signal = getAsyncWorkSignal();
        started.resolve();
        await fail.promise;
        expect(signal?.reason).toBe(reason);
        throw failure;
      },
      "plugin:fixture",
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = owner
      .run(() =>
        withPluginRuntimeRegistryScope(registry, () =>
          resolveContextEngine({ plugins: { slots: { contextEngine: "cancelled-factory" } } }),
        ),
      )
      .then(
        (engine) => ({ engine }),
        (error: unknown) => ({ error }),
      );
    try {
      await started.promise;
      owner.beginClose(reason);
      fail.resolve();
      const outcome = await result;
      if (mode === "unrelated-error") {
        expect(fallback).toHaveBeenCalledOnce();
        expect(listContextEngineQuarantines()).toMatchObject([
          { engineId: "cancelled-factory", operation: "factory", reason: failure.message },
        ]);
      } else {
        expect(outcome).toEqual({ error: failure });
        expect(fallback).not.toHaveBeenCalled();
        expect(listContextEngineQuarantines()).toEqual([]);
      }
      if ("engine" in outcome) {
        await outcome.engine.dispose?.();
      }
      await resources.release();
      // A rejected factory may still own cooperative descendants; admission joins them.
      expect(owner.hasPendingWork).toBe(true);
      expect(retired).not.toHaveBeenCalled();
      cleanupGate.resolve();
      await owner.drain();
      expect(retired).toHaveBeenCalledOnce();
    } finally {
      fail.resolve();
      cleanupGate.resolve();
      await result;
      await owner.drain();
      await resources.release();
    }
  },
);
