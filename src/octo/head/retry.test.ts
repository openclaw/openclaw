// Octopus Orchestrator -- RetryService tests (M3-07)

import { describe, expect, it } from "vitest";
import type { OctoRetryPolicyDefault } from "../config/schema.ts";
import type { RetryPolicy } from "../wire/schema.ts";
import { RetryService } from "./retry.ts";

// ──────────────────────────────────────────────────────────────────────────
// Fixtures
// ──────────────────────────────────────────────────────────────────────────

const DEFAULT_POLICY: OctoRetryPolicyDefault = {
  maxAttempts: 3,
  backoff: "exponential",
  initialDelayS: 5,
  maxDelayS: 300,
  multiplier: 2.0,
  retryOn: ["transient", "timeout", "adapter_error"],
  abandonOn: ["policy_denied", "invalid_spec", "unrecoverable"],
};

const WIRE_POLICY: RetryPolicy = {
  max_attempts: 4,
  backoff: "exponential",
  initial_delay_s: 2,
  max_delay_s: 60,
  multiplier: 2,
  retry_on: ["transient", "timeout"],
  abandon_on: ["policy_denied", "unrecoverable"],
};

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("RetryService", () => {
  const svc = new RetryService(DEFAULT_POLICY);

  // 1. Exponential delays double correctly
  it("computes exponential backoff with correct doubling", () => {
    // attempt 1 -> exponent 0 -> 2 * 2^0 = 2s = 2000ms
    expect(svc.computeDelay(1, WIRE_POLICY)).toBe(2000);
    // attempt 2 -> exponent 1 -> 2 * 2^1 = 4s = 4000ms
    expect(svc.computeDelay(2, WIRE_POLICY)).toBe(4000);
    // attempt 3 -> exponent 2 -> 2 * 2^2 = 8s = 8000ms
    expect(svc.computeDelay(3, WIRE_POLICY)).toBe(8000);
  });

  // 2. Exceed max_attempts -> no retry
  it("rejects retry when attemptCount reaches max_attempts", () => {
    const result = svc.shouldRetry(4, "transient", WIRE_POLICY);
    expect(result.retry).toBe(false);
    expect(result.reason).toContain("max_attempts");
  });

  // 3. policy_denied immediately abandoned
  it("immediately abandons on policy_denied", () => {
    const result = svc.shouldRetry(1, "policy_denied", WIRE_POLICY);
    expect(result.retry).toBe(false);
    expect(result.reason).toContain("abandon_on");
  });

  // 4. transient is retried
  it("retries transient failures within budget", () => {
    const result = svc.shouldRetry(1, "transient", WIRE_POLICY);
    expect(result.retry).toBe(true);
    expect(result.delay_ms).toBe(2000);
  });

  // 5. Delay clamped to max_delay_s
  it("clamps delay to max_delay_s", () => {
    const tightPolicy: RetryPolicy = {
      ...WIRE_POLICY,
      max_delay_s: 3, // 3 seconds max
    };
    // attempt 3 -> 2 * 2^2 = 8s, clamped to 3s = 3000ms
    expect(svc.computeDelay(3, tightPolicy)).toBe(3000);
  });

  // 6. Linear backoff
  it("computes linear backoff correctly", () => {
    const linearPolicy: RetryPolicy = {
      ...WIRE_POLICY,
      backoff: "linear",
      initial_delay_s: 10,
    };
    // attempt 1 -> 10 * 1 = 10s
    expect(svc.computeDelay(1, linearPolicy)).toBe(10_000);
    // attempt 2 -> 10 * 2 = 20s
    expect(svc.computeDelay(2, linearPolicy)).toBe(20_000);
    // attempt 3 -> 10 * 3 = 30s
    expect(svc.computeDelay(3, linearPolicy)).toBe(30_000);
  });

  // 7. Fixed backoff
  it("computes fixed backoff correctly", () => {
    const fixedPolicy: RetryPolicy = {
      ...WIRE_POLICY,
      backoff: "fixed",
      initial_delay_s: 7,
    };
    expect(svc.computeDelay(1, fixedPolicy)).toBe(7000);
    expect(svc.computeDelay(2, fixedPolicy)).toBe(7000);
    expect(svc.computeDelay(5, fixedPolicy)).toBe(7000);
  });

  // 8. Uses default policy when none provided
  it("falls back to default policy when no explicit policy given", () => {
    // Default: maxAttempts=3, exponential, initialDelayS=5, multiplier=2
    // transient is in retryOn
    const result = svc.shouldRetry(1, "transient");
    expect(result.retry).toBe(true);
    // attempt 1 -> 5 * 2^0 = 5s = 5000ms
    expect(result.delay_ms).toBe(5000);
  });

  // 9. Failure class not in retry_on or abandon_on
  it("rejects retry when failure class is not in retry_on", () => {
    // adapter_error is NOT in WIRE_POLICY.retry_on (only transient, timeout)
    const result = svc.shouldRetry(1, "adapter_error", WIRE_POLICY);
    expect(result.retry).toBe(false);
    expect(result.reason).toContain("not in retry_on");
  });

  // 10. abandon_on takes priority over retry_on overlap
  it("abandon_on takes priority when class appears in both lists", () => {
    const overlapping: RetryPolicy = {
      ...WIRE_POLICY,
      retry_on: ["transient", "policy_denied"],
      abandon_on: ["policy_denied"],
    };
    const result = svc.shouldRetry(1, "policy_denied", overlapping);
    expect(result.retry).toBe(false);
    expect(result.reason).toContain("abandon_on");
  });
});
