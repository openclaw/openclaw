import { describe, expect, it, vi } from "vitest";
import {
  resolveCacheTtlMs,
  isCacheEnabled,
  createExpiringMapCache,
} from "./cache-utils.js";

describe("resolveCacheTtlMs", () => {
  it("returns parsed env value when valid", () => {
    expect(resolveCacheTtlMs({ envValue: "60000", defaultTtlMs: 30000 })).toBe(60000);
  });

  it("returns default for undefined env value", () => {
    expect(resolveCacheTtlMs({ envValue: undefined, defaultTtlMs: 30000 })).toBe(30000);
  });

  it("returns default for invalid env value", () => {
    expect(resolveCacheTtlMs({ envValue: "invalid", defaultTtlMs: 30000 })).toBe(30000);
  });

  it("returns default for negative env value", () => {
    expect(resolveCacheTtlMs({ envValue: "-1000", defaultTtlMs: 30000 })).toBe(30000);
  });
});

describe("isCacheEnabled", () => {
  it("returns true for positive ttl", () => {
    expect(isCacheEnabled(1000)).toBe(true);
    expect(isCacheEnabled(1)).toBe(true);
  });

  it("returns false for zero ttl", () => {
    expect(isCacheEnabled(0)).toBe(false);
  });

  it("returns false for negative ttl", () => {
    expect(isCacheEnabled(-1000)).toBe(false);
  });
});

describe("createExpiringMapCache", () => {
  it("stores and retrieves values", () => {
    const cache = createExpiringMapCache({ ttlMs: 1000 });
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("returns undefined for missing keys", () => {
    const cache = createExpiringMapCache({ ttlMs: 1000 });
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("deletes values", () => {
    const cache = createExpiringMapCache({ ttlMs: 1000 });
    cache.set("key", "value");
    cache.delete("key");
    expect(cache.get("key")).toBeUndefined();
  });

  it("clears all values", () => {
    const cache = createExpiringMapCache({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });

  it("returns correct size", () => {
    const cache = createExpiringMapCache({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.size()).toBe(2);
  });

  it("returns keys", () => {
    const cache = createExpiringMapCache({ ttlMs: 1000 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.keys()).toContain("a");
    expect(cache.keys()).toContain("b");
  });

  it("returns undefined when cache is disabled", () => {
    const cache = createExpiringMapCache({ ttlMs: 0 });
    cache.set("key", "value");
    expect(cache.get("key")).toBeUndefined();
  });

  it("respects ttl expiration", () => {
    let currentTime = 1000;
    const cache = createExpiringMapCache({
      ttlMs: 500,
      clock: () => currentTime,
    });
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
    currentTime = 2000; // past TTL
    expect(cache.get("key")).toBeUndefined();
  });

  it("pruneExpired removes expired entries", () => {
    let currentTime = 1000;
    const cache = createExpiringMapCache({
      ttlMs: 500,
      clock: () => currentTime,
    });
    cache.set("key", "value");
    currentTime = 2000;
    cache.pruneExpired();
    expect(cache.get("key")).toBeUndefined();
  });
});
