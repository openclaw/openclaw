import { extractErrorCode, formatErrorMessage } from "./errors.js";

/**
 * Error categories for retry decisions.
 *
 * - `retryable`   – transient server/network errors (502, 503, ECONNRESET)
 * - `rate_limit`  – provider rate limit (429, Retry-After)
 * - `auth`        – authentication failure (401, 403) — never retry
 * - `billing`     – quota/billing exceeded (402) — never retry
 * - `fatal`       – client error or permanent (400, 404, 501) — never retry
 * - `unknown`     – unclassified — retry once cautiously
 */
export type ErrorCategory =
  | "retryable"
  | "rate_limit"
  | "auth"
  | "billing"
  | "fatal"
  | "unknown";

export type ClassifiedError = {
  category: ErrorCategory;
  retryable: boolean;
  cooldownMs: number;
  reason: string;
};

// ---------------------------------------------------------------------------
// Network error codes (Node.js)
// ---------------------------------------------------------------------------

const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);

const FATAL_CODES = new Set([
  "ENOTFOUND",
  "EACCES",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

// ---------------------------------------------------------------------------
// HTTP status → category
// ---------------------------------------------------------------------------

function classifyStatus(status: number): ClassifiedError | undefined {
  if (status === 429) {
    return { category: "rate_limit", retryable: true, cooldownMs: 60_000, reason: `HTTP ${status}` };
  }
  if (status === 401 || status === 403) {
    return { category: "auth", retryable: false, cooldownMs: 0, reason: `HTTP ${status}` };
  }
  if (status === 402) {
    return { category: "billing", retryable: false, cooldownMs: 0, reason: `HTTP ${status}` };
  }
  // 501 Not Implemented — must come before the generic 4xx/5xx catch-alls
  if (status === 501) {
    return { category: "fatal", retryable: false, cooldownMs: 0, reason: `HTTP ${status} Not Implemented` };
  }
  if (status >= 400 && status < 500) {
    return { category: "fatal", retryable: false, cooldownMs: 0, reason: `HTTP ${status}` };
  }
  if (status >= 500 && status <= 599) {
    return { category: "retryable", retryable: true, cooldownMs: 5_000, reason: `HTTP ${status}` };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Extract HTTP status from various error shapes
// ---------------------------------------------------------------------------

function extractStatus(err: Record<string, unknown>): number | undefined {
  for (const key of ["status", "statusCode"] as const) {
    const v = err[key];
    if (typeof v === "number" && v >= 100) {
      return v;
    }
  }
  const response = err.response;
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    if (typeof r.status === "number") return r.status;
    if (typeof r.statusCode === "number") return r.statusCode;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Message-based pattern matching (provider-specific)
// ---------------------------------------------------------------------------

type MsgPattern = { test: RegExp; category: ErrorCategory; cooldownMs: number; reason: string };

const MSG_PATTERNS: MsgPattern[] = [
  { test: /exceeded.*quota|quota.*exceeded/i, category: "billing", cooldownMs: 0, reason: "API quota exceeded" },
  { test: /rate.?limit/i, category: "rate_limit", cooldownMs: 60_000, reason: "Rate limit" },
  { test: /overloaded/i, category: "retryable", cooldownMs: 10_000, reason: "Provider overloaded" },
  { test: /timeout|timed?\s*out/i, category: "retryable", cooldownMs: 5_000, reason: "Timeout" },
  { test: /ECONNRESET|socket hang up/i, category: "retryable", cooldownMs: 3_000, reason: "Connection reset" },
];

// ---------------------------------------------------------------------------
// Main classification
// ---------------------------------------------------------------------------

/**
 * Classify an error into a category so the retry system can decide whether to
 * retry, back off, or bail out immediately.
 *
 * Works with plain objects, Error instances, Axios/fetch/undici response
 * shapes, and raw strings.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (error === null || error === undefined) {
    return { category: "unknown", retryable: false, cooldownMs: 0, reason: "Null error" };
  }

  const err =
    typeof error === "object" ? (error as Record<string, unknown>) : { message: String(error) };

  // 1. HTTP status
  const status = extractStatus(err);
  if (status !== undefined) {
    const classified = classifyStatus(status);
    if (classified) return classified;
  }

  // 2. Node.js error code
  const code = extractErrorCode(error);
  if (code) {
    if (RETRYABLE_CODES.has(code)) {
      return { category: "retryable", retryable: true, cooldownMs: 3_000, reason: `Network: ${code}` };
    }
    if (FATAL_CODES.has(code)) {
      return { category: "fatal", retryable: false, cooldownMs: 0, reason: `Fatal: ${code}` };
    }
  }

  // 3. Message patterns (OpenAI, Anthropic, generic)
  const msg = formatErrorMessage(error);
  for (const p of MSG_PATTERNS) {
    if (p.test.test(msg)) {
      const retryable = p.category === "retryable" || p.category === "rate_limit";
      return { category: p.category, retryable, cooldownMs: p.cooldownMs, reason: p.reason };
    }
  }

  // 4. Fallback: unknown — retry once cautiously
  return { category: "unknown", retryable: true, cooldownMs: 5_000, reason: "Unclassified" };
}

// ---------------------------------------------------------------------------
// Integration helper: shouldRetry predicate for retryAsync
// ---------------------------------------------------------------------------

/**
 * Drop-in `shouldRetry` predicate for `retryAsync()`.
 * Returns true only for errors classified as retryable or rate-limited.
 */
export function isRetryableError(err: unknown): boolean {
  return classifyError(err).retryable;
}

/**
 * Drop-in `retryAfterMs` extractor for `retryAsync()`.
 * Returns the suggested cooldown from classification, or undefined to let
 * the default backoff apply.
 */
export function retryAfterMs(err: unknown): number | undefined {
  const c = classifyError(err);
  return c.cooldownMs > 0 ? c.cooldownMs : undefined;
}
