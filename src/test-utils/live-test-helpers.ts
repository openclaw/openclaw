import { describe } from "vitest";

/**
 * Shared utilities for live test files:
 * - `describeLive` — suite-level skip with yellow message when keys are missing
 * - `classifyLiveError` — categorize errors from external services
 * - `withLiveRetry` — retry with exponential backoff on rate-limit errors
 */

// ---------------------------------------------------------------------------
// describeLive
// ---------------------------------------------------------------------------

type EnvVarSpec = {
  name: string;
  value: string | undefined;
  required?: boolean;
};

type DescribeLiveOpts = {
  name: string;
  envVars: EnvVarSpec[];
};

/**
 * Returns `describe` when all required env vars are set AND a LIVE flag is
 * truthy. Returns `describe.skip` otherwise, logging a yellow message naming
 * the missing key(s).
 *
 * The LIVE flag is checked via `OPENCLAW_LIVE_TEST` or `LIVE` env vars,
 * plus any provider-specific flags passed via `envVars` with `required: false`.
 */
export function describeLive(opts: DescribeLiveOpts): typeof describe | typeof describe.skip {
  const liveFlag = isTruthy(process.env.OPENCLAW_LIVE_TEST) || isTruthy(process.env.LIVE);

  // Provider-specific live flags are passed as non-required env vars whose
  // name ends with _LIVE_TEST or _LIVE — treat them as alternative live flags.
  const providerLiveFlags = opts.envVars.filter(
    (v) => !v.required && /_LIVE(?:_TEST)?$/.test(v.name),
  );
  const hasProviderLive = providerLiveFlags.some((v) => isTruthy(v.value));

  if (!liveFlag && !hasProviderLive) {
    logSkip(opts.name, ["OPENCLAW_LIVE_TEST or LIVE"]);
    return describe.skip;
  }

  const missing = opts.envVars
    .filter((v) => v.required !== false && !v.value?.trim())
    .map((v) => v.name);

  if (missing.length > 0) {
    logSkip(opts.name, missing);
    return describe.skip;
  }

  return describe;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes";
}

function logSkip(suiteName: string, missingKeys: string[]): void {
  const keys = missingKeys.join(", ");
  // Yellow ANSI escape for visibility in terminal output.
  console.log(
    `\x1b[33m[live-skip] ${suiteName}: missing ${keys} \u2014 export or add to .env\x1b[0m`,
  );
}

// ---------------------------------------------------------------------------
// classifyLiveError
// ---------------------------------------------------------------------------

export type LiveErrorType = "auth" | "rate-limit" | "unavailable" | "network" | "logic";

export type ClassifiedError = {
  type: LiveErrorType;
  message: string;
};

/**
 * Classify an error from an external service into one of five categories.
 * Returns a clean message with no stack trace.
 */
export function classifyLiveError(err: unknown): ClassifiedError {
  const message = stripStackTrace(String(err));

  const lower = message.toLowerCase();

  // Auth errors: 401, 403, unauthorized, forbidden, invalid key, billing
  if (
    /\b401\b/.test(lower) ||
    /\b403\b/.test(lower) ||
    /\bunauthorized\b/.test(lower) ||
    /\bforbidden\b/.test(lower) ||
    /invalid.*key/i.test(lower) ||
    /\bbilling\b/.test(lower)
  ) {
    return { type: "auth", message };
  }

  // Rate limit: 429, rate limit, too many requests, quota
  if (
    /\b429\b/.test(lower) ||
    /rate.limit/i.test(lower) ||
    /too many requests/i.test(lower) ||
    /\bquota\b/.test(lower)
  ) {
    return { type: "rate-limit", message };
  }

  // Unavailable: 502, 503, service unavailable, ECONNREFUSED, ETIMEDOUT
  if (
    /\b502\b/.test(lower) ||
    /\b503\b/.test(lower) ||
    /service unavailable/i.test(lower) ||
    /\bECONNREFUSED\b/i.test(message) ||
    /\bETIMEDOUT\b/i.test(message)
  ) {
    return { type: "unavailable", message };
  }

  // Network: ECONNRESET, EPIPE, fetch failed, abort
  if (
    /\bECONNRESET\b/i.test(message) ||
    /\bEPIPE\b/i.test(message) ||
    /fetch failed/i.test(lower) ||
    /\babort/i.test(lower)
  ) {
    return { type: "network", message };
  }

  // Everything else is a real test failure.
  return { type: "logic", message };
}

/**
 * Strip stack trace lines from an error string.
 * Removes lines that start with whitespace followed by "at " or are
 * continuation of a stack frame.
 */
function stripStackTrace(str: string): string {
  const lines = str.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s+at\s/.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

// ---------------------------------------------------------------------------
// withLiveRetry
// ---------------------------------------------------------------------------

type LiveRetryOpts = {
  retries?: number;
  baseDelayMs?: number;
};

/**
 * Retry an async function on rate-limit errors with exponential backoff.
 * Auth and unavailable errors throw immediately (no retry).
 * Default: 2 retries, 1000ms base delay.
 */
export async function withLiveRetry<T>(fn: () => Promise<T>, opts?: LiveRetryOpts): Promise<T> {
  const maxRetries = opts?.retries ?? 2;
  const baseDelay = opts?.baseDelayMs ?? 1000;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classifyLiveError(err);

      // Don't retry auth or unavailable — they won't resolve with time.
      if (classified.type === "auth" || classified.type === "unavailable") {
        throw err;
      }

      // Only retry rate-limit errors.
      if (classified.type !== "rate-limit") {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = baseDelay * 2 ** attempt;
        console.log(
          `[live-retry] attempt ${attempt + 1}/${maxRetries + 1}: ${classified.message} — retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
