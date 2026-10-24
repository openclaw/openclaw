import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { withPluginRuntimeRegistryScope as withRegistry } from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope, getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { ensureContextEnginesInitialized } from "./init.js";
import { LegacyContextEngine } from "./legacy.js";
import { createNativeSource, createRegistryFixture } from "./registry-resources.test-support.js";
import {
  listContextEngineQuarantines as listQuarantines,
  registerContextEngineInRegistry as registerEngine,
  resolveContextEngine,
} from "./registry.js";
import { resetContextEngineRuntimeQuarantineForTests as resetQuarantine } from "./registry.test-support.js";
import type { ContextEngine } from "./types.js";

beforeEach(() => resetQuarantine());

afterEach(async () => {
  await resetQuarantine();
  vi.restoreAllMocks();
});

it.each(["closed-scope", "released-source"] as const)(
  "propagates host admission failure without quarantining an uncalled factory (%s)",
  async (mode) => {
    const { registry, resources, retired: retire } = createRegistryFixture();
    const selectedId = `admission-${mode}`;
    const configuredFactory = vi.fn(() => new LegacyContextEngine());
    const fallbackFactory = vi.fn(() => new LegacyContextEngine());
    registerEngine(registry, selectedId, configuredFactory, "plugin:fixture");
    registerEngine(registry, "legacy", fallbackFactory, "core");
    const resolve = () =>
      withRegistry(registry, () =>
        resolveContextEngine({
          plugins: {
            entries: { fixture: { enabled: true } },
            slots: { contextEngine: selectedId },
          },
        }),
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
      expect(await listQuarantines()).toEqual([]);
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

it.each(["reason", "wrapped-reason", "abort-error", "unrelated-error"] as const)(
  "distinguishes factory cancellation from plugin failure (%s)",
  async (mode) => {
    const { registry, resources, retired } = createRegistryFixture();
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
    registerEngine(registry, "legacy", fallback, "core");
    registerEngine(
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
        withRegistry(registry, () =>
          resolveContextEngine({
            plugins: {
              entries: { fixture: { enabled: true } },
              slots: { contextEngine: "cancelled-factory" },
            },
          }),
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
        expect(await listQuarantines()).toMatchObject([
          { engineId: "cancelled-factory", operation: "factory", reason: failure.message },
        ]);
      } else {
        expect(outcome).toEqual({ error: failure });
        expect(fallback).not.toHaveBeenCalled();
        expect(await listQuarantines()).toEqual([]);
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

it.each(["success", "failure", "abort"] as const)(
  "retains the foreground source until initialization settles (%s)",
  async (mode) => {
    const { registry, resources, database, retired, read } = createNativeSource();
    const factory = vi.fn(() => {
      expect(read()).toBe(42);
      return new LegacyContextEngine();
    });
    registerEngine(registry, "initialized-source", factory, "plugin:fixture");
    const started = createDeferred();
    const gate = createDeferred();
    const owner = new AsyncWorkScope();
    const failure = new Error("initialization rejected");
    const pending = owner.run(() =>
      withRegistry(registry, () =>
        resolveContextEngine(
          {
            plugins: {
              entries: { fixture: { enabled: true } },
              slots: { contextEngine: "initialized-source" },
            },
          },
          {
            initialize: async () => {
              await ensureContextEnginesInitialized();
              started.resolve();
              await gate.promise;
            },
          },
        ),
      ),
    );
    void pending.catch(() => {});
    let engine: ContextEngine | undefined;
    try {
      await started.promise;
      await resources.release();
      expect(database.isOpen).toBe(true);
      expect(factory).not.toHaveBeenCalled();
      if (mode === "failure" || mode === "abort") {
        if (mode === "failure") {
          gate.reject(failure);
        } else {
          owner.beginClose(failure);
          gate.resolve();
        }
        await expect(pending).rejects.toBe(failure);
        expect(factory).not.toHaveBeenCalled();
        expect(await listQuarantines()).toEqual([]);
      } else {
        gate.resolve();
        engine = await pending;
        expect(factory).toHaveBeenCalledOnce();
        await engine.dispose?.();
      }
      await owner.drain();
      expect(retired).toHaveBeenCalledOnce();
      expect(database.isOpen).toBe(false);
    } finally {
      gate.resolve();
      await pending.catch(() => {});
      await engine?.dispose?.();
      await owner.drain();
      await resources.release();
      if (database.isOpen) {
        database.close();
      }
    }
  },
);
