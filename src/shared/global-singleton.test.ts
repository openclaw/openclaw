import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  drainGlobalSingletonLifecycleState,
  registerGlobalSingletonFinalResourceReset,
  resolveGlobalMap,
  resolveGlobalSingleton,
} from "./global-singleton.js";

const TEST_KEY = Symbol("global-singleton:test");
const TEST_MAP_KEY = Symbol("global-singleton:test-map");

afterEach(() => {
  delete (globalThis as Record<PropertyKey, unknown>)[TEST_KEY];
  delete (globalThis as Record<PropertyKey, unknown>)[TEST_MAP_KEY];
});

describe("resolveGlobalSingleton", () => {
  it("reuses an initialized singleton", () => {
    const create = vi.fn(() => ({ value: 1 }));

    const first = resolveGlobalSingleton(TEST_KEY, create);
    const second = resolveGlobalSingleton(TEST_KEY, create);

    expect(first).toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not re-run the factory when undefined was already stored", () => {
    const create = vi.fn(() => undefined);

    expect(resolveGlobalSingleton(TEST_KEY, create)).toBeUndefined();
    expect(resolveGlobalSingleton(TEST_KEY, create)).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("resolveGlobalMap", () => {
  it("reuses the same map instance and preserves its contents", () => {
    const first = resolveGlobalMap<string, number>(TEST_MAP_KEY);
    first.set("a", 1);
    const second = resolveGlobalMap<string, number>(TEST_MAP_KEY);

    expect(first).toBe(second);
    expect(second.get("a")).toBe(1);
  });
});

describe("global singleton lifecycle resets", () => {
  it("registers an in-place reset for a prepopulated singleton", async () => {
    const existing = { values: new Set(["stale"]) };
    (globalThis as Record<PropertyKey, unknown>)[TEST_KEY] = existing;
    const resolved = resolveGlobalSingleton(
      TEST_KEY,
      () => ({ values: new Set<string>() }),
      (state) => state.values.clear(),
    );

    await drainGlobalSingletonLifecycleState();

    expect(resolved).toBe(existing);
    expect(existing.values.size).toBe(0);
  });

  it("keeps map resets registered across repeated lifecycle drains", async () => {
    const map = resolveGlobalMap<string, number>(TEST_MAP_KEY, (state) => state.clear());
    map.set("first", 1);
    await drainGlobalSingletonLifecycleState();
    map.set("second", 2);
    await drainGlobalSingletonLifecycleState();

    expect(map.size).toBe(0);
    expect(resolveGlobalMap<string, number>(TEST_MAP_KEY)).toBe(map);
  });

  it("keeps only the latest reset owner for a duplicated slot", async () => {
    const duplicateKey = Symbol("global-singleton:duplicate-owner");
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    resolveGlobalSingleton(duplicateKey, () => ({}), firstReset);
    resolveGlobalSingleton(duplicateKey, () => ({}), secondReset);

    await drainGlobalSingletonLifecycleState();

    expect(firstReset).not.toHaveBeenCalled();
    expect(secondReset).toHaveBeenCalledOnce();
    delete (globalThis as Record<PropertyKey, unknown>)[duplicateKey];
  });

  it("awaits asynchronous resets while starting sibling owners", async () => {
    const asyncKey = Symbol("global-singleton:async-reset");
    const siblingKey = Symbol("global-singleton:async-sibling");
    const { promise: held, resolve: release } = createDeferred();
    const siblingReset = vi.fn();
    resolveGlobalSingleton(
      asyncKey,
      () => ({}),
      async () => await held,
    );
    resolveGlobalSingleton(siblingKey, () => ({}), siblingReset);

    const drain = drainGlobalSingletonLifecycleState();
    try {
      expect(siblingReset).toHaveBeenCalledOnce();
    } finally {
      release();
      try {
        await drain;
      } finally {
        delete (globalThis as Record<PropertyKey, unknown>)[asyncKey];
        delete (globalThis as Record<PropertyKey, unknown>)[siblingKey];
      }
    }
  });

  it("joins ordinary owners before final resource cleanup and reports every failure", async () => {
    const failingKey = Symbol("global-singleton:failing-reset");
    const succeedingKey = Symbol("global-singleton:succeeding-reset");
    const finalKey = Symbol("global-singleton:final-resource");
    const { promise: held, resolve: release } = createDeferred();
    const ownerFailure = new Error("owner reset failed");
    const resourceFailure = new Error("resource reset failed");
    const order: string[] = [];
    let shouldThrow = true;
    const succeedingReset = vi.fn(() => {
      order.push("sibling");
    });
    const finalReset = vi.fn(() => {
      order.push("final");
      if (shouldThrow) {
        throw resourceFailure;
      }
    });
    resolveGlobalSingleton(
      failingKey,
      () => ({}),
      async () => {
        order.push("owner-start");
        await held;
        order.push("owner-settled");
        if (shouldThrow) {
          throw ownerFailure;
        }
      },
    );
    resolveGlobalSingleton(succeedingKey, () => ({}), succeedingReset);
    registerGlobalSingletonFinalResourceReset(finalKey, finalReset);

    const drain = drainGlobalSingletonLifecycleState().catch((error: unknown) => error);
    try {
      expect(succeedingReset).toHaveBeenCalledOnce();
      expect(finalReset).not.toHaveBeenCalled();
      release();
      const failure = await drain;
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected both lifecycle reset failures", { cause: failure });
      }
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBe(ownerFailure);
      expect(failure.errors[1]).toBe(resourceFailure);
      expect(finalReset).toHaveBeenCalledOnce();
      expect(order).toEqual(["owner-start", "sibling", "owner-settled", "final"]);
    } finally {
      release();
      await drain;
      shouldThrow = false;
      for (const key of [failingKey, succeedingKey, finalKey]) {
        delete (globalThis as Record<PropertyKey, unknown>)[key];
      }
    }
  });

  it("preserves close-only state across restart drains", async () => {
    const closeOnlyKey = Symbol("global-singleton:close-only");
    const state = resolveGlobalMap<string, number>(
      closeOnlyKey,
      (value) => value.clear(),
      "close-only",
    );
    state.set("pending", 1);

    await drainGlobalSingletonLifecycleState("restart");
    expect(state.get("pending")).toBe(1);

    await drainGlobalSingletonLifecycleState("close");
    expect(state.size).toBe(0);
    delete (globalThis as Record<PropertyKey, unknown>)[closeOnlyKey];
  });
});
