/**
 * Generic ingress retry backoff and dead-letter decisions.
 *
 * Channel-specific non-retryable classification stays out of core; pass it in.
 */
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { PreparedModelRuntimeRecoveryError } from "../../agents/prepared-model-runtime-admission-errors.js";
import { computeBackoff } from "../../infra/backoff.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";

export const DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS = 8;
export const DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_RETRY_BASE_MS = 1_000;
export const DEFAULT_INGRESS_RETRY_MAX_MS = 3 * 60_000;
const MAX_RECOVERY_RETRIES = 4_096;

type IngressRecoveryRetry = { recoveryFailures: number; nextEligibleAt?: number };
// Budgets reset on process restart because runtime owners re-publish on startup.
const recoveryRetries = new WeakMap<object, Map<string, IngressRecoveryRetry>>();

export type IngressRetryPolicyConfig = {
  maxAttempts?: number;
  deadLetterMinAgeMs?: number;
  baseMs?: number;
  maxMs?: number;
};

type IngressRetryEventFacts = {
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
  retry?: IngressRecoveryRetry;
};

export type IngressNonRetryableFailure = {
  reason: string;
  message: string;
};

type IngressFailureDisposition =
  | {
      kind: "fail";
      reason: string;
      message: string;
      attempt: number;
    }
  | {
      kind: "release";
      attempt: number;
      message: string;
      recordAttempt?: boolean;
      retry?: IngressRecoveryRetry;
    };

/** Remaining backoff delay before a released event may be claimed again. */
export function resolveIngressRetryDelayMs(
  event: IngressRetryEventFacts,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): number {
  const retry = event.retry;
  if (retry?.nextEligibleAt !== undefined) {
    return Math.max(0, retry.nextEligibleAt - now);
  }
  const baseMs = config?.baseMs ?? DEFAULT_INGRESS_RETRY_BASE_MS;
  const maxMs = config?.maxMs ?? DEFAULT_INGRESS_RETRY_MAX_MS;
  const attempts = event.attempts ?? 0;
  if (!event.lastError || event.lastAttemptAt === undefined || attempts <= 0) {
    return 0;
  }
  const delayMs = computeBackoff(
    { initialMs: baseMs, maxMs, factor: 2, jitter: 0 },
    Math.min(attempts, 9),
  );
  return Math.max(0, event.lastAttemptAt + delayMs - now);
}

/**
 * Dead-letter requires BOTH attempt floor and minimum age.
 * Over-limit events keep retrying at the capped delay until age is met.
 */
export function shouldDeadLetterRetryableIngressEvent(
  event: IngressRetryEventFacts,
  attempt: number,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): boolean {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS;
  const deadLetterMinAgeMs =
    config?.deadLetterMinAgeMs ?? DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS;
  return attempt >= maxAttempts && now - event.receivedAt >= deadLetterMinAgeMs;
}

/** Resolve release vs fail for a dispatch error using optional non-retryable hook. */
export function resolveIngressFailureDisposition(params: {
  err: unknown;
  event: IngressRetryEventFacts;
  formatError: (err: unknown) => string;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  config?: IngressRetryPolicyConfig;
  now?: number;
}): IngressFailureDisposition {
  const now = params.now ?? Date.now();
  const attempt = (params.event.attempts ?? 0) + 1;
  const message = params.formatError(params.err);
  const nonRetryable = params.resolveNonRetryableFailure?.(params.err) ?? null;
  if (nonRetryable) {
    return {
      kind: "fail",
      reason: nonRetryable.reason,
      message: nonRetryable.message,
      attempt,
    };
  }
  const errors = collectNestedErrorCandidates(params.err);
  const previousRetry = params.event.retry;
  const recovery = errors.find(
    (error): error is PreparedModelRuntimeRecoveryError =>
      error instanceof PreparedModelRuntimeRecoveryError,
  );
  if (recovery) {
    const attempted = recovery.reason === "attempt-failed";
    const recoveryFailures = (previousRetry?.recoveryFailures ?? 0) + (attempted ? 1 : 0);
    if (attempted && recoveryFailures >= 2) {
      return { kind: "fail", reason: "runtime-recovery-failed", message, attempt };
    }
    return {
      kind: "release",
      attempt: attempted ? attempt : (params.event.attempts ?? 0),
      message,
      recordAttempt: attempted,
      retry: { recoveryFailures, nextEligibleAt: recovery.nextEligibleAt },
    };
  }
  const reason = shouldDeadLetterRetryableIngressEvent(params.event, attempt, params.config, now)
    ? "retry-limit-exceeded"
    : undefined;
  return reason
    ? { kind: "fail", reason, message, attempt }
    : {
        kind: "release",
        attempt,
        message,
        ...(previousRetry ? { retry: { recoveryFailures: previousRetry.recoveryFailures } } : {}),
      };
}

/** Keep recovery facts with the live queue owner, outside durable error text. */
export function createIngressRetryPolicy(owner: object) {
  const retries = recoveryRetries.get(owner) ?? new Map<string, IngressRecoveryRetry>();
  recoveryRetries.set(owner, retries);
  type Event = IngressRetryEventFacts & { id: string };
  return {
    clear: (id: string) => retries.delete(id),
    delay: (event: Event, config?: IngressRetryPolicyConfig, now = Date.now()) =>
      resolveIngressRetryDelayMs({ ...event, retry: retries.get(event.id) }, config, now),
    failure: (
      params: Parameters<typeof resolveIngressFailureDisposition>[0] & { event: Event },
    ) => {
      const disposition = resolveIngressFailureDisposition({
        ...params,
        event: { ...params.event, retry: retries.get(params.event.id) },
      });
      if (disposition.kind === "fail") {
        return disposition;
      }
      const { retry, ...release } = disposition;
      if (retry) {
        retries.delete(params.event.id);
        retries.set(params.event.id, retry);
        pruneMapToMaxSize(retries, MAX_RECOVERY_RETRIES);
      } else {
        retries.delete(params.event.id);
      }
      return release;
    },
  };
}
