/** Fingerprints cron failure signatures and classifies repeated-failure stagnation safely. */
import type { FailoverReason } from "../agents/failover/signal.js";
import type { CronFailureNotificationDetail, CronRunStatus } from "./types.js";

/** Consecutive identical-signature failures required before treating a streak as stagnated. */
export const DEFAULT_CRON_STAGNATION_STREAK_THRESHOLD = 3;

const MAX_SIGNATURE_ERROR_CHARS = 240;

type GenericCronErrorReason = "unknown" | "unclassified" | "no_error_details";
export type SpecificCronErrorReason = Exclude<FailoverReason, GenericCronErrorReason>;

const GENERIC_ERROR_REASONS = new Set<FailoverReason>([
  "unknown",
  "unclassified",
  "no_error_details",
]);

const AUTHORITY_OR_AUTH_REASONS = new Set<FailoverReason>(["auth", "auth_permanent", "billing"]);

const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const KEYED_COUNTER_PATTERN =
  /\b(pid|cid|req|request[_-]?id|run[_-]?id|attempt)(\s*[=:]\s*|\s+)(?:\d+|[0-9a-f-]{8,})\b/gi;
const CONTEXTUAL_DURATION_PATTERN =
  /\b(after|in|for|took|elapsed|waited)\s+\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/gi;

const AUTHORITY_OR_AUTH_TEXT_PATTERN =
  /\b(?:permission\s+denied|not\s+authorized|unauthorized|forbidden|access\s+denied|approval\s+required|denied\s+by\s+policy|caller[- ]scope|toolsallow|insufficient\s+(?:permissions?|scopes?)|(?:http|status(?:[ _-]code)?)\s*[=:]?\s*(?:401|403))\b/i;

export type CronStagnationDisposition = "explore_new_approach" | "authority_or_auth_gate";

export type CronJobStagnationClassification =
  | { kind: "healthy" }
  | { kind: "healthy_wait" }
  | { kind: "paused" }
  | { kind: "unknown_outcome" }
  | { kind: "distinct_or_early_failure"; boundary: "general" | "authority_or_auth" }
  | {
      kind: "repeated_failure_stagnation";
      streak: number;
      disposition: CronStagnationDisposition;
    };

/** True when `errorReason` names a specific provider/runtime cause rather than a generic fallback. */
export function isSpecificCronErrorReason(
  errorReason: FailoverReason | undefined,
): errorReason is SpecificCronErrorReason {
  return errorReason !== undefined && !GENERIC_ERROR_REASONS.has(errorReason);
}

/** Normalizes volatile per-run tokens in raw cron error text while preserving ports, status codes, and paths. */
export function normalizeCronErrorSignatureText(error: string | undefined): string | undefined {
  const trimmed = error?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(UUID_PATTERN, "<uuid>")
    .replace(ISO_TIMESTAMP_PATTERN, "<ts>")
    .replace(KEYED_COUNTER_PATTERN, (_match, key: string) => `${key.toLowerCase()}=<id>`)
    .replace(
      CONTEXTUAL_DURATION_PATTERN,
      (_match, prefix: string) => `${prefix.toLowerCase()} <dur>`,
    )
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, MAX_SIGNATURE_ERROR_CHARS) : undefined;
}

/** Selects the stable failure cause hashed into cron incident dedupe signatures. */
export function normalizeCronFailureSignatureCause(params: {
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
}): CronFailureNotificationDetail | string | undefined {
  if (isSpecificCronErrorReason(params.errorReason)) {
    return params.errorReason;
  }
  if (params.failureNotificationDetail !== undefined) {
    return params.failureNotificationDetail;
  }
  const normalizedError = normalizeCronErrorSignatureText(params.error);
  if (normalizedError !== undefined) {
    return normalizedError;
  }
  return params.errorReason;
}

/** True when a cron failure reflects a permission, policy, approval, sign-in, or billing gate. */
export function isCronAuthorityOrAuthBoundary(params: {
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
}): boolean {
  if (params.errorReason && AUTHORITY_OR_AUTH_REASONS.has(params.errorReason)) {
    return true;
  }
  if (
    params.failureNotificationDetail?.kind === "agent-stall" &&
    params.failureNotificationDetail.classification === "blocked_tool_call"
  ) {
    return true;
  }
  return typeof params.error === "string" && AUTHORITY_OR_AUTH_TEXT_PATTERN.test(params.error);
}

/**
 * Classifies whether a cron job is genuinely stagnating on a repeated error signature, while
 * keeping high-volume healthy/no_change runs, in-flight or retry waits, pauses, and unknown
 * outcomes out of stagnation recovery.
 */
export function classifyCronJobStagnation(params: {
  enabled: boolean;
  terminalOneShot?: boolean;
  status: CronRunStatus;
  outcome?: string;
  consecutiveErrors: number;
  sameSignature?: boolean;
  threshold?: number;
  aborted?: boolean;
  interruptedByRestart?: boolean;
  pendingTransientRetry?: boolean;
  admissionDeferred?: boolean;
  runningAtMs?: number;
  queuedAtMs?: number;
  recentOkRuns?: number;
  error?: string;
  errorReason?: FailoverReason;
  failureNotificationDetail?: CronFailureNotificationDetail;
}): CronJobStagnationClassification {
  if (
    (!params.enabled && !params.terminalOneShot) ||
    params.aborted === true ||
    params.interruptedByRestart === true
  ) {
    return { kind: "paused" };
  }
  if (
    params.pendingTransientRetry === true ||
    params.admissionDeferred === true ||
    typeof params.runningAtMs === "number" ||
    typeof params.queuedAtMs === "number"
  ) {
    return { kind: "healthy_wait" };
  }
  if (params.status === "ok" || (params.status === "skipped" && params.consecutiveErrors <= 0)) {
    return { kind: "healthy" };
  }
  const hasSubstantiveCause =
    isSpecificCronErrorReason(params.errorReason) ||
    params.failureNotificationDetail !== undefined ||
    normalizeCronErrorSignatureText(params.error) !== undefined;
  if (!hasSubstantiveCause) {
    return { kind: "unknown_outcome" };
  }
  const authorityBoundary = isCronAuthorityOrAuthBoundary(params);
  const threshold = Math.max(2, params.threshold ?? DEFAULT_CRON_STAGNATION_STREAK_THRESHOLD);
  if (params.sameSignature === true && params.consecutiveErrors >= threshold) {
    return {
      kind: "repeated_failure_stagnation",
      streak: params.consecutiveErrors,
      disposition: authorityBoundary ? "authority_or_auth_gate" : "explore_new_approach",
    };
  }
  return {
    kind: "distinct_or_early_failure",
    boundary: authorityBoundary ? "authority_or_auth" : "general",
  };
}
