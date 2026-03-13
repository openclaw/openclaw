import { describe, expect, it } from "vitest";
import { createDedupeCache } from "./dedupe.js";

describe("createDedupeCache", () => {
  it("returns false for first check (not duplicate)", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 100 });
    expect(cache.check("key1")).toBe(false);
    expect(cache.check("key2")).toBe(false);
  });

  it("returns true for duplicate within TTL", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 100 });
    cache.check("key1");
    expect(cache.check("key1")).toBe(true);
  });

  it("returns false after TTL expires", () => {
    const cache = createDedupeCache({ ttlMs: 100, maxSize: 100 });
    const now = Date.now();
    
    cache.check("key1", now);
    expect(cache.check("key1", now + 50)).toBe(true); // Within TTL
    expect(cache.check("key1", now + 150)).toBe(false); // After TTL
  });

  it("handles null/undefined keys", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 100 });
    expect(cache.check(null)).toBe(false);
    expect(cache.check(undefined)).toBe(false);
    expect(cache.check("")).toBe(false);
  });

  it("peek returns true without updating timestamp", () => {
    const cache = createDedupeCache({ ttlMs: 100, maxSize: 100 });
    const now = Date.now();
    
    cache.check("key1", now);
    expect(cache.peek("key1", now + 50)).toBe(true);
    // Peek doesn't touch, so it should expire based on original timestamp
    expect(cache.peek("key1", now + 150)).toBe(false);
  });

  it("clears all entries", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 100 });
    cache.check("key1");
    cache.check("key2");
    expect(cache.size()).toBe(2);
    
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.check("key1")).toBe(false); // Can add again after clear
  });

  it("enforces max size by pruning oldest", () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 3 });
    
    cache.check("key1");
    cache.check("key2");
    cache.check("key3");
    expect(cache.size()).toBe(3);
    
    // Adding 4th should prune oldest (key1)
    cache.check("key4");
    expect(cache.size()).toBe(3);
    // key1 was pruned, so checking it should return false and add it back
    expect(cache.check("key1")).toBe(false); // key1 was pruned, now re-added
    expect(cache.peek("key2")).toBe(true);  // key2 still exists
  });

  it("handles zero TTL", () => {
    const cache = createDedupeCache({ ttlMs: 0, maxSize: 100 });
    const now = Date.now();
    
    cache.check("key1", now);
    // With TTL=0, entries should be considered expired immediately
    expect(cache.check("key1", now + 1)).toBe(false);
  });

  it("handles zero max size", () => {
    const cache = createDedupeCache({ ttlMs: 1000, maxSize: 0 });
    cache.check("key1");
    // With maxSize=0, cache should be cleared
    expect(cache.size()).toBe(0);
  });

  it("updates LRU order on check", () => {
    const cache = createDedupeCache({ ttlMs: 10000, maxSize: 3 });
    
    cache.check("key1");
    cache.check("key2");
    cache.check("key3");
    
    // Access key1 to make it recently used
    cache.check("key1");
    
    // Add key4, should prune key2 (oldest)
    cache.check("key4");
    expect(cache.check("key1")).toBe(true); // key1 was touched, stays
    expect(cache.check("key2")).toBe(false); // key2 was oldest, pruned
  });
});

