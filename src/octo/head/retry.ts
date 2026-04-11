// Octopus Orchestrator -- RetryService (M3-07)
//
// Evaluates whether a failed grip should be retried based on failure
// classification, attempt count, and backoff policy. Computes the delay
// before the next attempt using the configured backoff strategy.
//
// Context docs:
//   - LLD.md §Retry and Backoff -- failure classifications and policy
//   - CONFIG.md §octo.retryPolicyDefault -- operator-tunable defaults
//   - DECISIONS.md OCTO-DEC-033 -- boundary discipline
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins and relative imports inside `src/octo/` are
//   permitted. No external dependencies.

import type { OctoRetryPolicyDefault } from "../config/schema.ts";
import type { BackoffStrategy, FailureClassification, RetryPolicy } from "../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Result type returned by shouldRetry
// ──────────────────────────────────────────────────────────────────────────

export interface RetryDecision {
  retry: boolean;
  delay_ms?: number;
  reason?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// RetryService
// ──────────────────────────────────────────────────────────────────────────

export class RetryService {
  constructor(private readonly defaultPolicy: OctoRetryPolicyDefault) {}

  /**
   * Decide whether a grip should be retried after a failure.
   *
   * When `policy` is provided it is used directly (wire snake_case shape).
   * When absent the service falls back to `defaultPolicy` (config camelCase
   * shape), translating field names on the fly.
   */
  shouldRetry(
    attemptCount: number,
    failureClass: FailureClassification,
    policy?: RetryPolicy,
  ): RetryDecision {
    const resolved = policy ?? this.toWirePolicy(this.defaultPolicy);

    // Abandon-list takes priority -- if the failure class is explicitly
    // listed in abandon_on, never retry regardless of retry_on.
    if (resolved.abandon_on.includes(failureClass)) {
      return { retry: false, reason: `${failureClass} is in abandon_on` };
    }

    // If the failure class is not in retry_on, do not retry.
    if (!resolved.retry_on.includes(failureClass)) {
      return { retry: false, reason: `${failureClass} is not in retry_on` };
    }

    // Budget check -- attemptCount is the number of attempts already made
    // (including the one that just failed).
    if (attemptCount >= resolved.max_attempts) {
      return {
        retry: false,
        reason: `attempt ${attemptCount} reached max_attempts ${resolved.max_attempts}`,
      };
    }

    const delay_ms = this.computeDelay(attemptCount, resolved);
    return { retry: true, delay_ms };
  }

  /**
   * Compute the delay in milliseconds before the next retry attempt.
   *
   * `attemptCount` is 1-based (the attempt that just failed). The delay
   * formula uses `attemptCount - 1` as the exponent/multiplier so the
   * first retry has delay = initial_delay_s (attempt 1 -> exponent 0).
   */
  computeDelay(attemptCount: number, policy: RetryPolicy): number {
    const rawS = this.rawDelay(
      attemptCount,
      policy.backoff,
      policy.initial_delay_s,
      policy.multiplier,
    );
    const clampedS = Math.min(rawS, policy.max_delay_s);
    return clampedS * 1000;
  }

  // ── private ────────────────────────────────────────────────────────────

  private rawDelay(
    attemptCount: number,
    backoff: BackoffStrategy,
    initialDelayS: number,
    multiplier: number,
  ): number {
    switch (backoff) {
      case "exponential":
        return initialDelayS * Math.pow(multiplier, attemptCount - 1);
      case "linear":
        return initialDelayS * attemptCount;
      case "fixed":
        return initialDelayS;
      default:
        return initialDelayS;
    }
  }

  private toWirePolicy(cfg: OctoRetryPolicyDefault): RetryPolicy {
    return {
      max_attempts: cfg.maxAttempts,
      backoff: cfg.backoff,
      initial_delay_s: cfg.initialDelayS,
      max_delay_s: cfg.maxDelayS,
      multiplier: cfg.multiplier,
      retry_on: cfg.retryOn,
      abandon_on: cfg.abandonOn,
    };
  }
}
