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
const register = (reset: () => void | Promise<void>, key = TEST_KEY) =>
  resolveGlobalSingleton(key, () => ({}), reset);

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
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    register(firstReset);
    register(secondReset);

    await drainGlobalSingletonLifecycleState();

    expect(firstReset).not.toHaveBeenCalled();
    expect(secondReset).toHaveBeenCalledOnce();
  });

  it("awaits asynchronous resets while starting sibling owners", async () => {
    const { promise: held, resolve: release } = createDeferred();
    const siblingReset = vi.fn();
    register(async () => await held);
    register(siblingReset, TEST_MAP_KEY);

    const drain = drainGlobalSingletonLifecycleState();
    try {
      expect(siblingReset).toHaveBeenCalledOnce();
    } finally {
      release();
      await drain;
    }
  });

  it("runs every registered reset before reporting failures", async () => {
    let shouldThrow = true;
    const succeedingReset = vi.fn();
    register(() => {
      if (shouldThrow) {
        throw new Error("reset failed");
      }
    });
    register(succeedingReset, TEST_MAP_KEY);

    try {
      await expect(drainGlobalSingletonLifecycleState()).rejects.toThrow(AggregateError);
      expect(succeedingReset).toHaveBeenCalledOnce();
    } finally {
      shouldThrow = false;
    }
  });

  it("retains shared state for terminal persistence after other owners close", async () => {
    const shared = resolveGlobalMap<string, string>(TEST_KEY, "shared-state");
    const runtime = resolveGlobalMap<string, string>(TEST_MAP_KEY, "close-and-restart");
    runtime.set("server", "running");
    shared.set("boot", "incomplete");

    await drainGlobalSingletonLifecycleState("close", { retainSharedState: true });
    expect(runtime.size).toBe(0);
    expect(shared.get("boot")).toBe("incomplete");
    shared.set("boot", "complete");
    await drainGlobalSingletonLifecycleState("shared-state");
    expect(shared.size).toBe(0);
  });

  it("preserves close-only state across restart drains", async () => {
    const state = resolveGlobalMap<string, number>(
      TEST_KEY,
      (value) => value.clear(),
      "close-only",
    );
    state.set("pending", 1);

    await drainGlobalSingletonLifecycleState("restart");
    expect(state.get("pending")).toBe(1);

    await drainGlobalSingletonLifecycleState("close");
    expect(state.size).toBe(0);
  });
});
