import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  drainGlobalSingletonLifecycleState as drain,
  readGlobalSingleton,
  resolveGlobalMap as mapFor,
  resolveGlobalSingleton,
} from "./global-singleton.js";

const TEST_KEY = Symbol("global-singleton:test");
const TEST_MAP_KEY = Symbol("global-singleton:test-map");
const register = (reset: () => void | Promise<void>, key = TEST_KEY) =>
  resolveGlobalSingleton(key, () => ({}), reset);

afterEach(() => [TEST_KEY, TEST_MAP_KEY].forEach((key) => Reflect.deleteProperty(globalThis, key)));

describe("resolveGlobalSingleton", () => {
  it("reuses an initialized singleton", () => {
    const create = vi.fn(() => ({ value: 1 }));

    expect(readGlobalSingleton(TEST_KEY)).toBeUndefined();
    const first = resolveGlobalSingleton(TEST_KEY, create);
    expect(resolveGlobalSingleton(TEST_KEY, create)).toBe(first);
    expect(readGlobalSingleton(TEST_KEY)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("keeps only the latest reset owner for a duplicated slot", async () => {
    const firstReset = vi.fn();
    const secondReset = vi.fn();
    register(firstReset);
    register(secondReset);

    await drain();

    expect(firstReset).not.toHaveBeenCalled();
    expect(secondReset).toHaveBeenCalledOnce();
  });

  it("awaits asynchronous resets while starting sibling owners", async () => {
    const { promise: held, resolve: release } = createDeferred();
    const siblingReset = vi.fn();
    register(() => held);
    register(siblingReset, TEST_MAP_KEY);

    const pending = drain();
    try {
      expect(siblingReset).toHaveBeenCalledOnce();
    } finally {
      release();
      await pending;
    }
  });

  it("runs every registered reset before reporting failures", async () => {
    const succeedingReset = vi.fn();
    register(() => {
      throw new Error("reset failed");
    });
    register(succeedingReset, TEST_MAP_KEY);

    try {
      await expect(drain()).rejects.toThrow(AggregateError);
      expect(succeedingReset).toHaveBeenCalledOnce();
    } finally {
      register(() => {});
    }
  });

  it("retains shared state for terminal persistence after other owners close", async () => {
    const shared = mapFor<string, string>(TEST_KEY, "shared-state");
    const runtime = mapFor<string, string>(TEST_MAP_KEY, "close-and-restart");
    runtime.set("server", "running");
    shared.set("boot", "incomplete");

    await drain("close", { retainSharedState: true });
    expect(runtime.size).toBe(0);
    expect(shared.get("boot")).toBe("incomplete");
    shared.set("boot", "complete");
    await drain("shared-state");
    expect(shared.size).toBe(0);
  });

  it("preserves close-only state across restart drains", async () => {
    const state = mapFor<string, number>(TEST_KEY, (value) => value.clear(), "close-only");
    state.set("pending", 1);

    await drain("restart");
    expect(state.get("pending")).toBe(1);

    await drain("close");
    expect(state.size).toBe(0);
  });
});
