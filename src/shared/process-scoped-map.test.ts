import { afterEach, describe, expect, it } from "vitest";
import { resolveProcessScopedMap } from "./process-scoped-map.js";

const MAP_KEY = Symbol("process-scoped-map:test");
const OTHER_MAP_KEY = Symbol("process-scoped-map:other");

afterEach(() => {
  delete (process as unknown as Record<symbol, unknown>)[MAP_KEY];
  delete (process as unknown as Record<symbol, unknown>)[OTHER_MAP_KEY];
});

describe("shared/process-scoped-map", () => {
  it("reuses the same map for the same symbol", () => {
    const first = resolveProcessScopedMap<number>(MAP_KEY);
    first.set("a", 1);

    const second = resolveProcessScopedMap<number>(MAP_KEY);

    expect(second).toBe(first);
    expect(second.get("a")).toBe(1);
  });

  it("keeps distinct maps for distinct symbols", () => {
    const first = resolveProcessScopedMap<number>(MAP_KEY);
    const second = resolveProcessScopedMap<number>(OTHER_MAP_KEY);

    expect(second).not.toBe(first);
  });

  it("reuses a prepopulated process map without replacing it", () => {
    const existing = new Map<string, number>([["a", 1]]);
    (process as unknown as Record<symbol, unknown>)[MAP_KEY] = existing;

    const resolved = resolveProcessScopedMap<number>(MAP_KEY);

    expect(resolved).toBe(existing);
    expect(resolved.get("a")).toBe(1);
  });
});
