import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalMap, resolveGlobalSingleton } from "./global-singleton.js";

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
  it("reuses the same map instance", () => {
    const first = resolveGlobalMap<string, number>(TEST_MAP_KEY);
    const second = resolveGlobalMap<string, number>(TEST_MAP_KEY);

    expect(first).toBe(second);
  });
});
