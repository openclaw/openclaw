import { describe, expect, it, vi } from "vitest";
import { withSessionStoreLockForTest } from "./store.js";

/**
 * @fileoverview Tests for session store lock queue limits (C1 fix)
 */

describe("Session Store Lock Queue", () => {
  it("should reject when lock queue exceeds MAX_LOCK_QUEUE_SIZE", async () => {
    // Create a test store path
    const storePath = `/tmp/test-lock-queue-${Date.now()}.json`;
    
    // Create many concurrent lock requests to exceed limit
    const requests: Promise<unknown>[] = [];
    let rejectionCount = 0;
    
    // Try to create more than MAX_LOCK_QUEUE_SIZE (1000) concurrent requests
    for (let i = 0; i < 1100; i++) {
      const request = withSessionStoreLockForTest(
        storePath,
        async () => {
          // Simulate some work
          await new Promise((r) => setTimeout(r, 100));
          return "done";
        },
        { timeoutMs: 5000 }
      ).catch((err) => {
        if (err.message?.includes("exceeded maximum size")) {
          rejectionCount++;
        }
        throw err;
      });
      requests.push(request);
    }
    
    // At least some requests should be rejected due to queue limit
    const results = await Promise.allSettled(requests);
    const rejected = results.filter((r) => r.status === "rejected").length;
    
    // We expect rejections due to queue limit
    expect(rejected).toBeGreaterThan(0);
    expect(rejectionCount).toBeGreaterThan(0);
  });

  it("should allow normal operations within queue limit", async () => {
    const storePath = `/tmp/test-lock-queue-normal-${Date.now()}.json`;
    
    // Create 10 concurrent requests (well within limit)
    const requests = Array.from({ length: 10 }, (_, i) =>
      withSessionStoreLockForTest(
        storePath,
        async () => `result-${i}`,
        { timeoutMs: 1000 }
      )
    );
    
    const results = await Promise.all(requests);
    
    // All should succeed
    expect(results).toHaveLength(10);
    results.forEach((result, i) => {
      expect(result).toBe(`result-${i}`);
    });
  });

  it("should clear queue after all tasks complete", async () => {
    const storePath = `/tmp/test-lock-queue-cleanup-${Date.now()}.json`;
    
    // Run some tasks
    await Promise.all([
      withSessionStoreLockForTest(storePath, async () => "a", { timeoutMs: 100 }),
      withSessionStoreLockForTest(storePath, async () => "b", { timeoutMs: 100 }),
    ]);
    
    // Queue should be cleaned up after completion
    // This is verified by the fact that we can run more tasks without hitting limit
    const moreResults = await Promise.all([
      withSessionStoreLockForTest(storePath, async () => "c", { timeoutMs: 100 }),
      withSessionStoreLockForTest(storePath, async () => "d", { timeoutMs: 100 }),
    ]);
    
    expect(moreResults).toEqual(["c", "d"]);
  });
});
