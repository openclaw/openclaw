import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing as controlPlaneRateLimitTesting,
  consumeControlPlaneWriteBudget,
  controlPlaneRateLimiterSize,
  disposeControlPlaneRateLimiter,
  pruneControlPlaneRateLimiter,
} from "./control-plane-rate-limit.js";

describe("control-plane rate limiter pruning", () => {
  beforeEach(() => {
    controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
  });

  afterEach(() => {
    controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
  });

  // ---------- prune ----------

  it("prunes expired buckets after the 60s window", () => {
    const baseMs = 1_000_000;

    // Create a bucket at baseMs.
    consumeControlPlaneWriteBudget({ client: null, nowMs: baseMs });
    expect(controlPlaneRateLimiterSize()).toBe(1);

    // Prune before the window expires – bucket should survive.
    pruneControlPlaneRateLimiter(baseMs + 30_000);
    expect(controlPlaneRateLimiterSize()).toBe(1);

    // Prune after the window expires – bucket should be removed.
    pruneControlPlaneRateLimiter(baseMs + 60_000);
    expect(controlPlaneRateLimiterSize()).toBe(0);
  });

  it("keeps non-expired buckets during prune", () => {
    const baseMs = 1_000_000;

    // Create two buckets at different times.
    consumeControlPlaneWriteBudget({
      client: { clientIp: "10.0.0.1" } as Parameters<
        typeof consumeControlPlaneWriteBudget
      >[0]["client"],
      nowMs: baseMs,
    });
    consumeControlPlaneWriteBudget({
      client: { clientIp: "10.0.0.2" } as Parameters<
        typeof consumeControlPlaneWriteBudget
      >[0]["client"],
      nowMs: baseMs + 50_000,
    });
    expect(controlPlaneRateLimiterSize()).toBe(2);

    // Prune at baseMs + 60_000: first bucket expired, second still fresh.
    pruneControlPlaneRateLimiter(baseMs + 60_000);
    expect(controlPlaneRateLimiterSize()).toBe(1);
  });

  // ---------- dispose ----------

  it("dispose() clears all state", () => {
    const baseMs = 1_000_000;
    consumeControlPlaneWriteBudget({ client: null, nowMs: baseMs });
    consumeControlPlaneWriteBudget({
      client: { clientIp: "10.0.0.5" } as Parameters<
        typeof consumeControlPlaneWriteBudget
      >[0]["client"],
      nowMs: baseMs,
    });
    expect(controlPlaneRateLimiterSize()).toBe(2);

    disposeControlPlaneRateLimiter();
    expect(controlPlaneRateLimiterSize()).toBe(0);
  });

  // ---------- size ----------

  it("size() returns the correct bucket count", () => {
    expect(controlPlaneRateLimiterSize()).toBe(0);

    const baseMs = 1_000_000;
    consumeControlPlaneWriteBudget({ client: null, nowMs: baseMs });
    expect(controlPlaneRateLimiterSize()).toBe(1);

    consumeControlPlaneWriteBudget({
      client: { clientIp: "10.0.0.3" } as Parameters<
        typeof consumeControlPlaneWriteBudget
      >[0]["client"],
      nowMs: baseMs,
    });
    expect(controlPlaneRateLimiterSize()).toBe(2);

    // Same key again should not increase the count.
    consumeControlPlaneWriteBudget({ client: null, nowMs: baseMs + 1_000 });
    expect(controlPlaneRateLimiterSize()).toBe(2);
  });
});
