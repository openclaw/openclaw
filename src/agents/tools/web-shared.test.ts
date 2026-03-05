import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCache } from "./web-shared.js";

type CacheEntry = {
  value: string;
  expiresAt: number;
  insertedAt: number;
};

const MAX_CACHE_ENTRIES = 100;
const TTL_MS = 60_000;

function buildCache(expiredLast = false): Map<string, CacheEntry> {
  const now = Date.now();
  const cache = new Map<string, CacheEntry>();
  for (let i = 0; i < MAX_CACHE_ENTRIES; i += 1) {
    cache.set(`key-${i}`, {
      value: `value-${i}`,
      expiresAt: now + TTL_MS,
      insertedAt: now + i,
    });
  }
  if (expiredLast) {
    cache.set("key-99", {
      value: "value-99",
      expiresAt: now - 1,
      insertedAt: now + 99,
    });
  }
  return cache;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("writeCache", () => {
  it("prunes expired entries before size-based eviction", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const cache = buildCache(true);
    writeCache(cache, "key-new", "value-new", TTL_MS);

    expect(cache.has("key-99")).toBe(false);
    expect(cache.has("key-0")).toBe(true);
    expect(cache.has("key-new")).toBe(true);
    expect(cache.size).toBe(MAX_CACHE_ENTRIES);
  });

  it("evicts the oldest entry when full without expired entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const cache = buildCache(false);
    writeCache(cache, "key-new", "value-new", TTL_MS);

    expect(cache.has("key-0")).toBe(false);
    expect(cache.has("key-1")).toBe(true);
    expect(cache.has("key-new")).toBe(true);
    expect(cache.size).toBe(MAX_CACHE_ENTRIES);
  });
});
