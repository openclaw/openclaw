/**
 * Tests for A2A Result Cache
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  storeA2AResult,
  getA2AResult,
  deleteA2AResult,
  hasA2AResult,
  getA2AResultCacheStats,
  cleanupExpiredResults,
  clearA2AResultCache,
  resetA2AResultCacheForTest,
  __testing,
} from "./a2a-result-cache.js";

describe("A2A Result Cache", () => {
  beforeEach(() => {
    resetA2AResultCacheForTest();
  });

  afterEach(() => {
    resetA2AResultCacheForTest();
  });

  describe("storeA2AResult", () => {
    it("stores a result and returns true", () => {
      const result = storeA2AResult("test-id-1", {
        status: "completed",
        correlationId: "test-id-1",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(result).toBe(true);
      expect(__testing.getCacheSize()).toBe(1);
    });

    it("rejects empty correlationId", () => {
      const result = storeA2AResult("", {
        status: "completed",
        correlationId: "",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(result).toBe(false);
      expect(__testing.getCacheSize()).toBe(0);
    });

    it("trims whitespace from correlationId", () => {
      const result = storeA2AResult("  trimmed-id  ", {
        status: "completed",
        correlationId: "trimmed-id",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(result).toBe(true);
      expect(getA2AResult("trimmed-id")).not.toBeNull();
    });

    it("evicts oldest entries when cache is full", () => {
      // Fill cache to max
      for (let i = 0; i < __testing.getMaxCacheSize(); i++) {
        storeA2AResult(`id-${i}`, {
          status: "completed",
          correlationId: `id-${i}`,
          targetSessionKey: "agent:test:main",
          skill: "test",
        });
      }

      expect(__testing.getCacheSize()).toBe(__testing.getMaxCacheSize());

      // Add one more - should evict oldest 10%
      storeA2AResult("new-id", {
        status: "completed",
        correlationId: "new-id",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      // Cache should still be <= max (after eviction)
      expect(__testing.getCacheSize()).toBeLessThanOrEqual(__testing.getMaxCacheSize());

      // Oldest entry should be evicted
      expect(getA2AResult("id-0")).toBeNull();
      // New entry should be present
      expect(getA2AResult("new-id")).not.toBeNull();
    });
  });

  describe("getA2AResult", () => {
    it("retrieves a stored result", () => {
      storeA2AResult("test-id", {
        status: "completed",
        correlationId: "test-id",
        targetSessionKey: "agent:test:main",
        skill: "test",
        output: { answer: 42 },
      });

      const result = getA2AResult("test-id");

      expect(result).not.toBeNull();
      expect(result?.status).toBe("completed");
      expect(result?.output).toEqual({ answer: 42 });
    });

    it("returns null for missing entries", () => {
      const result = getA2AResult("nonexistent");

      expect(result).toBeNull();
    });

    it("returns null for expired entries", async () => {
      // Store with very short TTL
      storeA2AResult(
        "short-ttl",
        {
          status: "completed",
          correlationId: "short-ttl",
          targetSessionKey: "agent:test:main",
          skill: "test",
        },
        1,
      ); // 1ms TTL

      // Wait for expiration
      await new Promise((r) => setTimeout(r, 10));

      const result = getA2AResult("short-ttl");

      expect(result).toBeNull();
    });

    it("deletes expired entries on access", async () => {
      storeA2AResult(
        "expiring",
        {
          status: "completed",
          correlationId: "expiring",
          targetSessionKey: "agent:test:main",
          skill: "test",
        },
        1,
      );

      await new Promise((r) => setTimeout(r, 10));

      getA2AResult("expiring");

      // Cache should no longer contain the entry
      expect(__testing.getCacheSize()).toBe(0);
    });
  });

  describe("deleteA2AResult", () => {
    it("deletes an existing entry", () => {
      storeA2AResult("to-delete", {
        status: "completed",
        correlationId: "to-delete",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(__testing.getCacheSize()).toBe(1);

      const deleted = deleteA2AResult("to-delete");

      expect(deleted).toBe(true);
      expect(__testing.getCacheSize()).toBe(0);
    });

    it("returns false for nonexistent entries", () => {
      const deleted = deleteA2AResult("nonexistent");

      expect(deleted).toBe(false);
    });
  });

  describe("hasA2AResult", () => {
    it("returns true for existing entries", () => {
      storeA2AResult("existing", {
        status: "completed",
        correlationId: "existing",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(hasA2AResult("existing")).toBe(true);
    });

    it("returns false for missing entries", () => {
      expect(hasA2AResult("missing")).toBe(false);
    });

    it("returns false for expired entries", async () => {
      storeA2AResult(
        "expired-check",
        {
          status: "completed",
          correlationId: "expired-check",
          targetSessionKey: "agent:test:main",
          skill: "test",
        },
        1,
      );

      await new Promise((r) => setTimeout(r, 10));

      expect(hasA2AResult("expired-check")).toBe(false);
    });
  });

  describe("getA2AResultCacheStats", () => {
    it("returns cache statistics", () => {
      storeA2AResult("stat-1", {
        status: "completed",
        correlationId: "stat-1",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      storeA2AResult("stat-2", {
        status: "completed",
        correlationId: "stat-2",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      const stats = getA2AResultCacheStats();

      expect(stats.size).toBe(2);
      expect(stats.maxSize).toBe(__testing.getMaxCacheSize());
      expect(stats.oldestEntry).toBeDefined();
      expect(stats.newestEntry).toBeDefined();
      expect(stats.newestEntry).toBeGreaterThanOrEqual(stats.oldestEntry!);
    });
  });

  describe("cleanupExpiredResults", () => {
    it("removes expired entries", async () => {
      // Store two entries - one with short TTL, one with default
      storeA2AResult(
        "expired",
        {
          status: "completed",
          correlationId: "expired",
          targetSessionKey: "agent:test:main",
          skill: "test",
        },
        1,
      );

      storeA2AResult("valid", {
        status: "completed",
        correlationId: "valid",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      await new Promise((r) => setTimeout(r, 10));

      const evicted = cleanupExpiredResults();

      expect(evicted).toBe(1);
      expect(__testing.getCacheSize()).toBe(1);
      expect(getA2AResult("valid")).not.toBeNull();
    });

    it("returns 0 when no entries are expired", () => {
      storeA2AResult("valid-1", {
        status: "completed",
        correlationId: "valid-1",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      const evicted = cleanupExpiredResults();

      expect(evicted).toBe(0);
      expect(__testing.getCacheSize()).toBe(1);
    });
  });

  describe("clearA2AResultCache", () => {
    it("clears all entries", () => {
      storeA2AResult("clear-1", {
        status: "completed",
        correlationId: "clear-1",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      storeA2AResult("clear-2", {
        status: "completed",
        correlationId: "clear-2",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(__testing.getCacheSize()).toBe(2);

      clearA2AResultCache();

      expect(__testing.getCacheSize()).toBe(0);
    });
  });
});
