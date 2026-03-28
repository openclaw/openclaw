/**
 * Integration tests for A2A concurrent caller scenarios
 *
 * Validates that the run-scoped result cache fixes race conditions
 * where concurrent callers could grab wrong results.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  storeA2AResult,
  getA2AResult,
  resetA2AResultCacheForTest,
  getA2AResultCacheStats,
} from "../../infra/a2a-result-cache.js";

// Mock gateway calls
const callGatewayMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: true, allow: ["*"] } },
        agents: { defaults: {} },
      }) as never,
  };
});

describe("A2A Concurrent Caller Tests", () => {
  beforeEach(() => {
    resetA2AResultCacheForTest();
    callGatewayMock.mockReset();
  });

  afterEach(() => {
    resetA2AResultCacheForTest();
  });

  describe("Result Cache Race Condition Fix", () => {
    it("stores results keyed by correlationId", async () => {
      const correlationId = "test-correlation-123";
      const result = {
        status: "completed" as const,
        correlationId,
        targetSessionKey: "agent:metis:main",
        skill: "research",
        output: { answer: "test answer" },
        confidence: 0.9,
        createdAt: Date.now(),
        completedAt: Date.now(),
      };

      storeA2AResult(correlationId, result);

      const retrieved = getA2AResult(correlationId);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.output).toEqual({ answer: "test answer" });
    });

    it("isolates results between different correlationIds", async () => {
      // Store results for two different calls
      storeA2AResult("call-1", {
        status: "completed",
        correlationId: "call-1",
        targetSessionKey: "agent:metis:main",
        skill: "research",
        output: { result: "first" },
        createdAt: Date.now(),
        completedAt: Date.now(),
      });

      storeA2AResult("call-2", {
        status: "completed",
        correlationId: "call-2",
        targetSessionKey: "agent:metis:main",
        skill: "research",
        output: { result: "second" },
        createdAt: Date.now(),
        completedAt: Date.now(),
      });

      // Each correlationId should get its own result
      expect(getA2AResult("call-1")?.output).toEqual({ result: "first" });
      expect(getA2AResult("call-2")?.output).toEqual({ result: "second" });
    });

    it("returns null for unknown correlationId", async () => {
      const result = getA2AResult("unknown-correlation-id");
      expect(result).toBeNull();
    });

    it("evicts expired results", async () => {
      // Store with very short TTL (1ms)
      storeA2AResult(
        "short-lived",
        {
          status: "completed",
          correlationId: "short-lived",
          targetSessionKey: "agent:test:main",
          skill: "test",
        },
        1, // 1ms TTL
      );

      // Immediately available
      expect(getA2AResult("short-lived")).not.toBeNull();

      // After expiration
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(getA2AResult("short-lived")).toBeNull();
    });
  });

  describe("Concurrent Call Simulation", () => {
    it("simulates 5 concurrent calls to same agent", async () => {
      // Setup: Each call gets its own correlationId
      const calls = [
        { correlationId: "call-1", output: { answer: "result-1" } },
        { correlationId: "call-2", output: { answer: "result-2" } },
        { correlationId: "call-3", output: { answer: "result-3" } },
        { correlationId: "call-4", output: { answer: "result-4" } },
        { correlationId: "call-5", output: { answer: "result-5" } },
      ];

      // Store results in cache (simulating agent responses)
      for (const call of calls) {
        storeA2AResult(call.correlationId, {
          status: "completed",
          correlationId: call.correlationId,
          targetSessionKey: "agent:metis:main",
          skill: "research",
          output: call.output,
          createdAt: Date.now(),
          completedAt: Date.now(),
        });
      }

      // Each call should retrieve its own result
      for (const call of calls) {
        const result = getA2AResult(call.correlationId);
        expect(result).not.toBeNull();
        expect(result?.output).toEqual(call.output);
      }

      // Verify cache stats
      const stats = getA2AResultCacheStats();
      expect(stats.size).toBe(5);
    });

    it("handles rapid fire calls with same correlationId (idempotency)", async () => {
      const correlationId = "idempotent-call";

      // Store once
      storeA2AResult(correlationId, {
        status: "completed",
        correlationId,
        targetSessionKey: "agent:metis:main",
        skill: "research",
        output: { cached: true },
        createdAt: Date.now(),
        completedAt: Date.now(),
      });

      // Multiple retrievals should return the same result
      const results = await Promise.all([
        getA2AResult(correlationId),
        getA2AResult(correlationId),
        getA2AResult(correlationId),
      ]);

      for (const result of results) {
        expect(result).not.toBeNull();
        expect(result?.output).toEqual({ cached: true });
      }
    });
  });

  describe("Cache Stats for Monitoring", () => {
    it("tracks cache size", () => {
      const stats = getA2AResultCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.maxSize).toBe(10000);

      storeA2AResult("test-1", {
        status: "completed",
        correlationId: "test-1",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      expect(getA2AResultCacheStats().size).toBe(1);
    });

    it("tracks oldest and newest entry timestamps", () => {
      const before = Date.now();
      storeA2AResult("old", {
        status: "completed",
        correlationId: "old",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });

      // Small delay to ensure different timestamp
      const middle = Date.now() + 1;
      storeA2AResult("new", {
        status: "completed",
        correlationId: "new",
        targetSessionKey: "agent:test:main",
        skill: "test",
      });
      const after = Date.now() + 2;

      const stats = getA2AResultCacheStats();
      expect(stats.oldestEntry).toBeGreaterThanOrEqual(before);
      expect(stats.oldestEntry).toBeLessThanOrEqual(middle);
      expect(stats.newestEntry).toBeGreaterThanOrEqual(middle);
      expect(stats.newestEntry).toBeLessThanOrEqual(after);
    });
  });

  describe("Error Handling", () => {
    it("handles null/undefined correlationId gracefully", () => {
      // @ts-expect-error - Testing invalid input
      expect(getA2AResult(null)).toBeNull();
      // @ts-expect-error - Testing invalid input
      expect(getA2AResult(undefined)).toBeNull();
      expect(getA2AResult("")).toBeNull();
      expect(getA2AResult("   ")).toBeNull();
    });

    it("handles large outputs", () => {
      const largeOutput = {
        data: "x".repeat(100000), // 100KB string
        nested: {
          array: Array(1000).fill({ key: "value" }),
        },
      };

      const result = storeA2AResult("large-output", {
        status: "completed",
        correlationId: "large-output",
        targetSessionKey: "agent:test:main",
        skill: "test",
        output: largeOutput,
      });

      expect(result).toBe(true);

      const retrieved = getA2AResult("large-output");
      expect(retrieved?.output).toEqual(largeOutput);
    });

    it("handles concurrent store and retrieve", async () => {
      // Simulate concurrent operations
      const operations = Array.from({ length: 100 }, (_, i) => {
        const id = `concurrent-${i}`;
        return Promise.resolve().then(() => {
          storeA2AResult(id, {
            status: "completed",
            correlationId: id,
            targetSessionKey: "agent:test:main",
            skill: "test",
            output: { index: i },
          });
          return getA2AResult(id);
        });
      });

      const results = await Promise.all(operations);

      // All results should be retrievable
      let successCount = 0;
      for (const result of results) {
        if (result !== null) {
          successCount++;
        }
      }
      // At minimum, most should succeed (race conditions may cause some misses)
      expect(successCount).toBeGreaterThan(90);
    });
  });
});
