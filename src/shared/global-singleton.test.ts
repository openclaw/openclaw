import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  drainGlobalSingletonLifecycleState,
  readGlobalSingleton,
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

    expect(readGlobalSingleton(TEST_KEY)).toBeUndefined();
    const first = resolveGlobalSingleton(TEST_KEY, create);
    const second = resolveGlobalSingleton(TEST_KEY, create);

    expect(first).toBe(second);
    expect(readGlobalSingleton(TEST_KEY)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("global singleton lifecycle resets", () => {
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

  it("runs every registered reset before reporting failures", async () => {
    const failingKey = Symbol("global-singleton:failing-reset");
    const succeedingKey = Symbol("global-singleton:succeeding-reset");
    let shouldThrow = true;
    const succeedingReset = vi.fn();
    resolveGlobalSingleton(
      failingKey,
      () => ({}),
      () => {
        if (shouldThrow) {
          throw new Error("reset failed");
        }
      },
    );
    resolveGlobalSingleton(succeedingKey, () => ({}), succeedingReset);

    try {
      await expect(drainGlobalSingletonLifecycleState()).rejects.toThrow(AggregateError);
      expect(succeedingReset).toHaveBeenCalledOnce();
    } finally {
      shouldThrow = false;
      delete (globalThis as Record<PropertyKey, unknown>)[failingKey];
      delete (globalThis as Record<PropertyKey, unknown>)[succeedingKey];
    }
  });

  it("retains shared state for terminal persistence after other owners close", async () => {
    const sharedKey = Symbol("global-singleton:shared-state");
    const shared = resolveGlobalMap<string, string>(sharedKey, "shared-state");
    const runtime = resolveGlobalMap<string, string>(TEST_MAP_KEY, "close-and-restart");
    runtime.set("server", "running");
    shared.set("boot", "incomplete");

    await drainGlobalSingletonLifecycleState("close", { retainSharedState: true });
    expect(runtime.size).toBe(0);
    expect(shared.get("boot")).toBe("incomplete");
    shared.set("boot", "complete");
    await drainGlobalSingletonLifecycleState("shared-state");
    expect(shared.size).toBe(0);
    delete (globalThis as Record<PropertyKey, unknown>)[sharedKey];
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
