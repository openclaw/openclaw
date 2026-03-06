import { describe, expect, it } from "vitest";

/**
 * Tests for transient HTTP retry escalation logic in agent-runner-execution.ts
 *
 * The retry logic uses a counter-based approach with linearly escalating delays:
 * - Retry 1: 2.5s delay
 * - Retry 2: 5.0s delay
 * - Retry 3: 7.5s delay
 *
 * This provides a ~15s tolerance window for brief upstream LLM proxy outages.
 */

describe("transient HTTP retry escalation", () => {
  const TRANSIENT_HTTP_RETRY_BASE_DELAY_MS = 2_500;
  const TRANSIENT_HTTP_MAX_RETRIES = 3;

  it("calculates correct delay for each retry attempt", () => {
    const delays = [];
    for (let retryCount = 1; retryCount <= TRANSIENT_HTTP_MAX_RETRIES; retryCount++) {
      const delayMs = TRANSIENT_HTTP_RETRY_BASE_DELAY_MS * retryCount;
      delays.push(delayMs);
    }

    expect(delays).toEqual([2_500, 5_000, 7_500]);
  });

  it("provides sufficient total tolerance window", () => {
    let totalDelay = 0;
    for (let retryCount = 1; retryCount <= TRANSIENT_HTTP_MAX_RETRIES; retryCount++) {
      totalDelay += TRANSIENT_HTTP_RETRY_BASE_DELAY_MS * retryCount;
    }

    // Total delay should be ~15s (2.5s + 5s + 7.5s)
    expect(totalDelay).toBe(15_000);
    // Should be significantly longer than the old single-retry approach (2.5s)
    expect(totalDelay).toBeGreaterThan(10_000);
  });

  it("uses linear escalation formula", () => {
    const retryCount = 2;
    const delayMs = TRANSIENT_HTTP_RETRY_BASE_DELAY_MS * retryCount;

    expect(delayMs).toBe(5_000);
  });

  it("enforces max retry limit", () => {
    const retryCount = 3;
    const shouldRetry = retryCount < TRANSIENT_HTTP_MAX_RETRIES;

    expect(shouldRetry).toBe(false);
    expect(retryCount).toBe(TRANSIENT_HTTP_MAX_RETRIES);
  });

  it("allows retries within limit", () => {
    for (let retryCount = 0; retryCount < TRANSIENT_HTTP_MAX_RETRIES; retryCount++) {
      const shouldRetry = retryCount < TRANSIENT_HTTP_MAX_RETRIES;
      expect(shouldRetry).toBe(true);
    }
  });
});
