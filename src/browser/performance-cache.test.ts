import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPerformanceCache,
  DEFAULT_CONFIG,
  formatCacheStats,
  PerformanceCache,
  type CacheConfig,
} from "./performance-cache.js";

describe("performance-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("PerformanceCache", () => {
    it("should create cache with default config", () => {
      const cache = new PerformanceCache("test-profile");
      
      expect(cache.size()).toBe(0);
      expect(cache.getConfig().enabled).toBe(true);
      expect(cache.getConfig().snapshotTtlMs).toBe(5000);
    });

    it("should create cache with custom config", () => {
      const config: Partial<CacheConfig> = {
        snapshotTtlMs: 10000,
        maxEntries: 10,
      };
      
      const cache = new PerformanceCache("test-profile", config);
      
      expect(cache.getConfig().snapshotTtlMs).toBe(10000);
      expect(cache.getConfig().maxEntries).toBe(10);
    });

    it("should store and retrieve snapshots", () => {
      const cache = new PerformanceCache("test-profile");
      const snapshot = { type: "snapshot", data: "test" };
      
      cache.setSnapshot("tab1", snapshot);
      
      expect(cache.size()).toBe(1);
      expect(cache.has("tab1")).toBe(true);
      
      const retrieved = cache.getSnapshot("tab1");
      expect(retrieved).toEqual(snapshot);
    });

    it("should return null for cache miss", () => {
      const cache = new PerformanceCache("test-profile");
      
      const result = cache.getSnapshot("nonexistent");
      
      expect(result).toBeNull();
    });

    it("should expire snapshots after TTL", () => {
      const cache = new PerformanceCache("test-profile", {
        snapshotTtlMs: 5000,
      });
      
      cache.setSnapshot("tab1", { data: "test" });
      
      // Initially should exist
      expect(cache.getSnapshot("tab1")).toBeTruthy();
      
      // Advance time past TTL
      vi.advanceTimersByTime(6000);
      
      // Should be expired
      expect(cache.getSnapshot("tab1")).toBeNull();
    });

    it("should track access count", () => {
      const cache = new PerformanceCache("test-profile");
      const snapshot = { data: "test" };
      
      cache.setSnapshot("tab1", snapshot);
      
      // Access multiple times
      cache.getSnapshot("tab1");
      cache.getSnapshot("tab1");
      cache.getSnapshot("tab1");
      
      const stats = cache.getStats();
      expect(stats.hitCount).toBe(3);
      expect(stats.missCount).toBe(0);
    });

    it("should calculate hit rate correctly", () => {
      const cache = new PerformanceCache("test-profile");
      
      cache.setSnapshot("tab1", { data: "test" });
      
      // 3 hits, 2 misses
      cache.getSnapshot("tab1"); // hit
      cache.getSnapshot("tab1"); // hit
      cache.getSnapshot("tab1"); // hit
      cache.getSnapshot("tab2"); // miss
      cache.getSnapshot("tab3"); // miss
      
      expect(cache.getHitRate()).toBe(60); // 3/5 = 60%
    });

    it("should invalidate specific snapshot", () => {
      const cache = new PerformanceCache("test-profile");
      
      cache.setSnapshot("tab1", { data: "test1" });
      cache.setSnapshot("tab2", { data: "test2" });
      
      expect(cache.size()).toBe(2);
      
      const deleted = cache.invalidate("tab1");
      
      expect(deleted).toBe(true);
      expect(cache.size()).toBe(1);
      expect(cache.has("tab1")).toBe(false);
      expect(cache.has("tab2")).toBe(true);
    });

    it("should invalidate all snapshots", () => {
      const cache = new PerformanceCache("test-profile");
      
      cache.setSnapshot("tab1", { data: "test1" });
      cache.setSnapshot("tab2", { data: "test2" });
      cache.setSnapshot("tab3", { data: "test3" });
      
      expect(cache.size()).toBe(3);
      
      const count = cache.invalidateAll();
      
      expect(count).toBe(3);
      expect(cache.size()).toBe(0);
    });

    it("should prune expired entries", () => {
      const cache = new PerformanceCache("test-profile", {
        snapshotTtlMs: 5000,
      });
      
      cache.setSnapshot("tab1", { data: "test1" });
      
      vi.advanceTimersByTime(2000);
      
      cache.setSnapshot("tab2", { data: "test2" });
      
      vi.advanceTimersByTime(4000);
      
      // tab1 is 6s old (expired), tab2 is 4s old (valid)
      const pruned = cache.pruneExpired();
      
      expect(pruned).toBe(1);
      expect(cache.size()).toBe(1);
      expect(cache.has("tab1")).toBe(false);
      expect(cache.has("tab2")).toBe(true);
    });

    it("should enforce max entries limit", () => {
      const cache = new PerformanceCache("test-profile", {
        maxEntries: 3,
      });
      
      cache.setSnapshot("tab1", { data: "test1" });
      cache.setSnapshot("tab2", { data: "test2" });
      cache.setSnapshot("tab3", { data: "test3" });
      
      expect(cache.size()).toBe(3);
      
      // Adding 4th should prune oldest
      cache.setSnapshot("tab4", { data: "test4" });
      
      expect(cache.size()).toBe(3);
    });

    it("should not cache when disabled", () => {
      const cache = new PerformanceCache("test-profile", {
        enabled: false,
      });
      
      cache.setSnapshot("tab1", { data: "test" });
      
      expect(cache.size()).toBe(0);
      expect(cache.getSnapshot("tab1")).toBeNull();
    });

    it("should clear cache when disabled via updateConfig", () => {
      const cache = new PerformanceCache("test-profile");
      
      cache.setSnapshot("tab1", { data: "test1" });
      cache.setSnapshot("tab2", { data: "test2" });
      
      expect(cache.size()).toBe(2);
      
      cache.updateConfig({ enabled: false });
      
      expect(cache.size()).toBe(0);
    });

    it("should reset statistics", () => {
      const cache = new PerformanceCache("test-profile");
      
      cache.setSnapshot("tab1", { data: "test" });
      cache.getSnapshot("tab1");
      cache.getSnapshot("tab2");
      
      let stats = cache.getStats();
      expect(stats.hitCount).toBe(1);
      expect(stats.missCount).toBe(1);
      
      cache.resetStats();
      
      stats = cache.getStats();
      expect(stats.hitCount).toBe(0);
      expect(stats.missCount).toBe(0);
    });

    it("should handle has() with expired entry", () => {
      const cache = new PerformanceCache("test-profile", {
        snapshotTtlMs: 5000,
      });
      
      cache.setSnapshot("tab1", { data: "test" });
      
      expect(cache.has("tab1")).toBe(true);
      
      vi.advanceTimersByTime(6000);
      
      expect(cache.has("tab1")).toBe(false);
    });

    it("should provide accurate statistics", () => {
      const cache = new PerformanceCache("test-profile", {
        maxEntries: 50,
      });
      
      cache.setSnapshot("tab1", { data: "test1" });
      cache.setSnapshot("tab2", { data: "test2" });
      
      cache.getSnapshot("tab1"); // hit
      cache.getSnapshot("tab1"); // hit
      cache.getSnapshot("tab3"); // miss
      
      const stats = cache.getStats();
      
      expect(stats.size).toBe(2);
      expect(stats.maxEntries).toBe(50);
      expect(stats.hitCount).toBe(2);
      expect(stats.missCount).toBe(1);
      expect(stats.totalRequests).toBe(3);
      expect(stats.hitRate).toBe(67); // 2/3
      expect(stats.enabled).toBe(true);
    });
  });

  describe("createPerformanceCache", () => {
    it("should create a cache instance", () => {
      const cache = createPerformanceCache("test-profile");
      
      expect(cache).toBeInstanceOf(PerformanceCache);
      expect(cache.size()).toBe(0);
    });

    it("should accept custom configuration", () => {
      const config: Partial<CacheConfig> = {
        maxEntries: 20,
      };
      
      const cache = createPerformanceCache("test-profile", config);
      
      expect(cache.getConfig().maxEntries).toBe(20);
    });
  });

  describe("formatCacheStats", () => {
    it("should format cache statistics", () => {
      const stats = {
        size: 5,
        maxEntries: 50,
        hitCount: 10,
        missCount: 2,
        totalRequests: 12,
        hitRate: 83,
        enabled: true,
      };
      
      const formatted = formatCacheStats(stats);
      
      expect(formatted).toContain("enabled");
      expect(formatted).toContain("5/50");
      expect(formatted).toContain("83%");
      expect(formatted).toContain("10 hits");
      expect(formatted).toContain("2 misses");
    });

    it("should format disabled cache", () => {
      const stats = {
        size: 0,
        maxEntries: 50,
        hitCount: 0,
        missCount: 0,
        totalRequests: 0,
        hitRate: 0,
        enabled: false,
      };
      
      const formatted = formatCacheStats(stats);
      
      expect(formatted).toContain("disabled");
    });
  });
});
