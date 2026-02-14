/**
 * Tests for the cache manager
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CacheManager } from "./cache-manager.js";

describe("CacheManager", () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager({
      maxSizeInMB: 1, // Small size for testing
      defaultTTL: 1, // 1 second for quick expiration tests
      enableMetrics: false,
    });
  });

  afterEach(() => {
    cache.dispose();
  });

  describe("Basic Operations", () => {
    it("should store and retrieve values", async () => {
      await cache.set("web-search", "test-key", { data: "test-value" });
      const result = await cache.get("web-search", "test-key");
      expect(result).toEqual({ data: "test-value" });
    });

    it("should return null for non-existent keys", async () => {
      const result = await cache.get("web-search", "non-existent");
      expect(result).toBeNull();
    });

    it("should handle object keys", async () => {
      const key = { query: "test", count: 5 };
      await cache.set("web-search", key, { results: ["a", "b"] });
      const result = await cache.get("web-search", key);
      expect(result).toEqual({ results: ["a", "b"] });
    });

    it("should generate consistent keys for same object", async () => {
      const key1 = { b: 2, a: 1 }; // Different order
      const key2 = { a: 1, b: 2 };

      await cache.set("web-search", key1, "value1");
      const result = await cache.get("web-search", key2);
      expect(result).toBe("value1");
    });
  });

  describe("getOrSet", () => {
    it("should fetch and cache on miss", async () => {
      let fetchCount = 0;
      const fetcher = async () => {
        fetchCount++;
        return { data: "fetched" };
      };

      const result1 = await cache.getOrSet("web-search", "key1", fetcher);
      expect(result1.cached).toBe(false);
      expect(result1.value).toEqual({ data: "fetched" });
      expect(fetchCount).toBe(1);

      const result2 = await cache.getOrSet("web-search", "key1", fetcher);
      expect(result2.cached).toBe(true);
      expect(result2.value).toEqual({ data: "fetched" });
      expect(fetchCount).toBe(1); // Should not fetch again
    });

    it("should respect shouldCache config", async () => {
      const fetcher = async () => ({ text: "hi" }); // Short response

      // Model responses with text < 50 chars shouldn't be cached
      const result1 = await cache.getOrSet("model-response", "key1", fetcher);
      expect(result1.cached).toBe(false);

      const result2 = await cache.getOrSet("model-response", "key1", fetcher);
      expect(result2.cached).toBe(false); // Still not cached
    });
  });

  describe("TTL and Expiration", () => {
    it("should expire entries after TTL", async () => {
      await cache.set("web-search", "expire-key", "value", { ttl: 0.1 }); // 100ms

      const immediate = await cache.get("web-search", "expire-key");
      expect(immediate).toBe("value");

      await new Promise((resolve) => setTimeout(resolve, 150));

      const expired = await cache.get("web-search", "expire-key");
      expect(expired).toBeNull();
    });

    it("should use resource-specific TTL", async () => {
      // Embeddings have 24hr TTL by default
      await cache.set("embeddings", "embed-key", [1, 2, 3]);
      const result = await cache.get("embeddings", "embed-key");
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe("Invalidation", () => {
    it("should invalidate specific entries", async () => {
      await cache.set("web-search", "key1", "value1");
      await cache.set("web-search", "key2", "value2");

      const deleted = await cache.invalidate("web-search", "key1");
      expect(deleted).toBe(true);

      expect(await cache.get("web-search", "key1")).toBeNull();
      expect(await cache.get("web-search", "key2")).toBe("value2");
    });

    it("should invalidate by resource type", async () => {
      await cache.set("web-search", "key1", "value1");
      await cache.set("web-search", "key2", "value2");
      await cache.set("model-response", "key3", "value3");

      await cache.invalidateResourceType("web-search");

      expect(await cache.get("web-search", "key1")).toBeNull();
      expect(await cache.get("web-search", "key2")).toBeNull();
      expect(await cache.get("model-response", "key3")).toBe("value3");
    });

    it("should clear all caches", async () => {
      await cache.set("web-search", "key1", "value1");
      await cache.set("model-response", "key2", "value2");

      await cache.clearAll();

      expect(await cache.get("web-search", "key1")).toBeNull();
      expect(await cache.get("model-response", "key2")).toBeNull();
    });
  });

  describe("Statistics", () => {
    it("should track hit/miss statistics", async () => {
      await cache.set("web-search", "key1", "value1");

      // Hit
      await cache.get("web-search", "key1");
      // Miss
      await cache.get("web-search", "key2");
      // Miss
      await cache.get("web-search", "key3");

      const stats = await cache.getStats();
      expect(stats.global.hits).toBe(1);
      expect(stats.global.misses).toBe(2);
      expect(stats.global.hitRate).toBeCloseTo(33.33, 1);
    });

    it("should track cache size", async () => {
      const largeValue = "x".repeat(1000);
      await cache.set("web-search", "large-key", largeValue);

      const stats = await cache.getStats();
      expect(stats.global.size).toBeGreaterThan(1000);
      expect(stats.global.entries).toBe(1);
    });
  });

  describe("Effectiveness Report", () => {
    it("should generate effectiveness report", async () => {
      // Create some cache activity
      await cache.set("web-search", "key1", { results: [] });
      await cache.get("web-search", "key1"); // Hit
      await cache.get("web-search", "key2"); // Miss

      await cache.set("model-response", "key3", { content: "response" });
      await cache.get("model-response", "key3"); // Hit

      const report = await cache.getEffectivenessReport();

      expect(report.summary.totalHitRate).toBeGreaterThan(0);
      expect(report.summary.apiCallsSaved).toBe(2);
      expect(report.byResource.length).toBeGreaterThan(0);

      const webSearchStats = report.byResource.find((r) => r.type === "web-search");
      expect(webSearchStats).toBeDefined();
      expect(webSearchStats?.hitRate).toBeGreaterThan(0);
    });
  });
});

describe("CacheManager - Eviction", () => {
  it("should evict LRU entries when size limit is reached", async () => {
    const cache = new CacheManager({
      maxSizeInMB: 0.001, // Very small, ~1KB
      enableMetrics: false,
    });

    try {
      // Fill cache
      await cache.set("web-search", "key1", "x".repeat(100));
      await cache.set("web-search", "key2", "x".repeat(100));
      await cache.set("web-search", "key3", "x".repeat(100));

      // Access key2 to make it more recently used
      await cache.get("web-search", "key2");

      // Add a large entry that should trigger eviction
      await cache.set("web-search", "key4", "x".repeat(500));

      // key1 should be evicted (least recently used)
      expect(await cache.get("web-search", "key1")).toBeNull();
      // key2 should still be there (recently accessed)
      expect(await cache.get("web-search", "key2")).toBeDefined();
    } finally {
      cache.dispose();
    }
  });
});
