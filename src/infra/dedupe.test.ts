import { describe, expect, it } from "vitest";
import { createDedupeCache } from "./dedupe.js";
import { pruneMapToMaxSize } from "./map-size.js";

describe("pruneMapToMaxSize", () => {
  it("removes oldest entries when over limit", () => {
    const map = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    pruneMapToMaxSize(map, 2);
    expect(map.size).toBe(2);
    expect(map.has("a")).toBe(false);
    expect(map.has("c")).toBe(true);
  });

  it("clears map when maxSize is 0", () => {
    const map = new Map([["a", 1]]);
    pruneMapToMaxSize(map, 0);
    expect(map.size).toBe(0);
  });

  it("does nothing when under limit", () => {
    const map = new Map([["a", 1]]);
    pruneMapToMaxSize(map, 5);
    expect(map.size).toBe(1);
  });
});

describe("createDedupeCache", () => {
  it("returns false on first check, true on duplicate", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 100 });
    expect(cache.check("key1", 1000)).toBe(false);
    expect(cache.check("key1", 1001)).toBe(true);
  });

  it("returns false for null/undefined keys", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 100 });
    expect(cache.check(null)).toBe(false);
    expect(cache.check(undefined)).toBe(false);
  });

  it("expires entries after TTL", () => {
    const cache = createDedupeCache({ ttlMs: 100, maxSize: 100 });
    expect(cache.check("key1", 1000)).toBe(false);
    expect(cache.check("key1", 1050)).toBe(true); // within TTL
    expect(cache.check("key1", 1200)).toBe(false); // expired
  });

  it("respects maxSize", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 2 });
    cache.check("a", 1000);
    cache.check("b", 1001);
    cache.check("c", 1002); // should evict "a"
    expect(cache.size()).toBeLessThanOrEqual(2);
  });

  it("clear resets the cache", () => {
    const cache = createDedupeCache({ ttlMs: 10_000, maxSize: 100 });
    cache.check("key1", 1000);
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.check("key1", 1001)).toBe(false);
  });
});
