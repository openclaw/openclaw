import { describe, expect, it } from "vitest";
import {
  readCache,
  writeCache,
  resolveTimeoutSeconds,
  resolveCacheTtlMs,
  normalizeCacheKey,
  type CacheEntry,
} from "./web-shared.js";

describe("readCache / writeCache", () => {
  it("returns null for missing key", () => {
    const cache = new Map<string, CacheEntry<string>>();
    expect(readCache(cache, "missing")).toBeNull();
  });

  it("stores and retrieves a value", () => {
    const cache = new Map<string, CacheEntry<string>>();
    writeCache(cache, "k1", "hello", 60_000);
    const result = readCache(cache, "k1");
    expect(result).toEqual({ value: "hello", cached: true });
  });

  it("returns null and deletes expired entries", () => {
    const cache = new Map<string, CacheEntry<string>>();
    writeCache(cache, "k1", "hello", 60_000);

    // Manually expire the entry.
    const entry = cache.get("k1")!;
    entry.expiresAt = Date.now() - 1;

    expect(readCache(cache, "k1")).toBeNull();
    expect(cache.has("k1")).toBe(false);
  });

  it("does not write when ttlMs is zero or negative", () => {
    const cache = new Map<string, CacheEntry<string>>();
    writeCache(cache, "k1", "hello", 0);
    expect(cache.size).toBe(0);
    writeCache(cache, "k2", "hello", -1);
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest entry when cache is full", () => {
    const cache = new Map<string, CacheEntry<string>>();
    for (let i = 0; i < 100; i++) {
      writeCache(cache, `k${i}`, `v${i}`, 60_000);
    }
    expect(cache.size).toBe(100);

    // Writing one more should evict k0 (the oldest).
    writeCache(cache, "k100", "v100", 60_000);
    expect(cache.size).toBe(100);
    expect(cache.has("k0")).toBe(false);
    expect(cache.has("k1")).toBe(true);
    expect(cache.has("k100")).toBe(true);
  });

  it("promotes accessed entries to avoid premature LRU eviction", () => {
    const cache = new Map<string, CacheEntry<string>>();
    // Fill to capacity.
    for (let i = 0; i < 100; i++) {
      writeCache(cache, `k${i}`, `v${i}`, 60_000);
    }
    expect(cache.size).toBe(100);

    // Access k0 (the oldest) — should promote it to the end.
    const result = readCache(cache, "k0");
    expect(result).toEqual({ value: "v0", cached: true });

    // Write a new entry — should evict k1 (now the oldest), NOT k0.
    writeCache(cache, "k100", "v100", 60_000);
    expect(cache.size).toBe(100);
    expect(cache.has("k0")).toBe(true); // promoted, survived
    expect(cache.has("k1")).toBe(false); // now the oldest, evicted
    expect(cache.has("k100")).toBe(true);
  });
});

describe("resolveTimeoutSeconds", () => {
  it("returns the value when it is a finite number", () => {
    expect(resolveTimeoutSeconds(10, 30)).toBe(10);
  });

  it("clamps to minimum of 1", () => {
    expect(resolveTimeoutSeconds(0, 30)).toBe(1);
    expect(resolveTimeoutSeconds(-5, 30)).toBe(1);
  });

  it("uses fallback for non-number inputs", () => {
    expect(resolveTimeoutSeconds("abc", 30)).toBe(30);
    expect(resolveTimeoutSeconds(undefined, 30)).toBe(30);
    expect(resolveTimeoutSeconds(NaN, 30)).toBe(30);
    expect(resolveTimeoutSeconds(Infinity, 30)).toBe(30);
  });
});

describe("resolveCacheTtlMs", () => {
  it("converts minutes to milliseconds", () => {
    expect(resolveCacheTtlMs(15, 10)).toBe(900_000);
  });

  it("clamps negative to zero", () => {
    expect(resolveCacheTtlMs(-5, 10)).toBe(0);
  });

  it("uses fallback for non-number inputs", () => {
    expect(resolveCacheTtlMs("abc" as unknown as number, 10)).toBe(600_000);
    expect(resolveCacheTtlMs(undefined as unknown as number, 10)).toBe(600_000);
  });
});

describe("normalizeCacheKey", () => {
  it("trims and lowercases", () => {
    expect(normalizeCacheKey("  Hello World  ")).toBe("hello world");
  });
});
