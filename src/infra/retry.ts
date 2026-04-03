import { sleep } from "../utils.js";
import { generateSecureFraction } from "./secure-random.js";

export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  jitter?: number;
};

export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
};

export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  onRetry?: (info: RetryInfo) => void;
};

const DEFAULT_RETRY_CONFIG = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

const RATE_LIMIT_RETRY_AFTER_RE =
  /retry[- ]after(?:[- _]?(ms|milliseconds?|msecs?|mins?|minutes?|m|s|seconds?|secs?))?[^\d]*(\d+(?:\.\d+)?)\s*(milliseconds?|msecs?|ms|minutes?|mins?|seconds?|secs?|m|s)?/i;
const RATE_LIMIT_MESSAGE_RE =
  /\b(?:429|too many requests|rate[_ -]?limit(?:ed)?|throttl(?:ed|ing)|resource exhausted)\b/i;

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asNumericString = (value: unknown): number | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const asStatusCode = (value: unknown): number | undefined => asFiniteNumber(value) ?? asNumericString(value);

const clampNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
  const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
};

export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = Math.max(1, Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)));
  const minDelayMs = Math.max(
    0,
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0)),
  );
  const jitter = clampNumber(overrides?.jitter, defaults.jitter, 0, 1);
  return { attempts, minDelayMs, maxDelayMs, jitter };
}

function applyJitter(delayMs: number, jitter: number): number {
  if (jitter <= 0) {
    return delayMs;
  }
  const offset = (generateSecureFraction() * 2 - 1) * jitter;
  return Math.max(0, Math.round(delayMs * (1 + offset)));
}

const parseRetryAfterHeaderValue = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds * 1000));
  }
  const atMs = Date.parse(trimmed);
  if (Number.isNaN(atMs)) {
    return undefined;
  }
  return Math.max(0, atMs - Date.now());
};

const extractRetryAfterMsFromError = (err: unknown): number | undefined => {
  const retryAfterMsCandidate = (err as { retryAfterMs?: unknown } | null | undefined)
    ?.retryAfterMs;
  const directRetryAfterMs = asFiniteNumber(retryAfterMsCandidate);
  if (directRetryAfterMs !== undefined) {
    return Math.max(0, Math.round(directRetryAfterMs));
  }

  const retryAfterCandidate = (err as { retryAfter?: unknown } | null | undefined)?.retryAfter;
  const directRetryAfterSeconds = asFiniteNumber(retryAfterCandidate);
  if (directRetryAfterSeconds !== undefined) {
    return Math.max(0, Math.round(directRetryAfterSeconds * 1000));
  }
  if (typeof retryAfterCandidate === "string") {
    const parsed = parseRetryAfterHeaderValue(retryAfterCandidate);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const candidates = [
    (err as { response?: { headers?: Headers | Record<string, unknown> } } | null | undefined)
      ?.response?.headers,
    (err as { headers?: Headers | Record<string, unknown> } | null | undefined)?.headers,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const parsed = parseRetryAfterHeaderValue(candidate);
      if (parsed !== undefined) {
        return parsed;
      }
      continue;
    }
    if (candidate instanceof Headers) {
      const parsed = parseRetryAfterHeaderValue(candidate.get("retry-after") ?? "");
      if (parsed !== undefined) {
        return parsed;
      }
      continue;
    }
    const headerValue =
      typeof candidate === "object" && candidate !== null
        ? (candidate["retry-after"] ?? candidate["Retry-After"])
        : undefined;
    if (typeof headerValue === "string") {
      const parsed = parseRetryAfterHeaderValue(headerValue);
      if (parsed !== undefined) {
        return parsed;
      }
    }
  }

  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const retryAfterDateMatch = message.match(
    /retry[- ]after[^A-Za-z0-9]*([A-Z][a-z]{2},\s*\d{2}\s+[A-Z][a-z]{2}\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT)/i,
  );
  if (retryAfterDateMatch) {
    const parsed = parseRetryAfterHeaderValue(retryAfterDateMatch[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const retryAfterMatch = RATE_LIMIT_RETRY_AFTER_RE.exec(message);
  if (retryAfterMatch) {
    const amount = Number(retryAfterMatch[2]);
    if (Number.isFinite(amount)) {
      const unit = (retryAfterMatch[3] ?? retryAfterMatch[1])?.toLowerCase();
      if (!unit || unit === "s" || unit.startsWith("sec")) {
        return Math.max(0, Math.round(amount * 1000));
      }
      if (unit === "ms" || unit.startsWith("msec") || unit.startsWith("millisecond")) {
        return Math.max(0, Math.round(amount));
      }
      if (unit === "m" || unit.startsWith("min")) {
        return Math.max(0, Math.round(amount * 60_000));
      }
    }
  }
  return undefined;
};

const isRateLimitLikeError = (err: unknown): boolean => {
  const responseStatus = asStatusCode(
    (err as { response?: { status?: unknown; statusCode?: unknown } } | null | undefined)?.response
      ?.status,
  );
  const responseStatusCode = asStatusCode(
    (err as { response?: { status?: unknown; statusCode?: unknown } } | null | undefined)?.response
      ?.statusCode,
  );
  const status =
    asStatusCode((err as { status?: unknown } | null | undefined)?.status) ??
    asStatusCode((err as { statusCode?: unknown } | null | undefined)?.statusCode) ??
    asStatusCode((err as { code?: unknown } | null | undefined)?.code) ??
    responseStatus ??
    responseStatusCode;
  if (status === 429) {
    return true;
  }
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return RATE_LIMIT_MESSAGE_RE.test(message);
};

export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  if (typeof attemptsOrOptions === "number") {
    const attempts = Math.max(1, Math.round(attemptsOrOptions));
    let lastErr: unknown;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (i === attempts - 1) {
          break;
        }
        const delay = initialDelayMs * 2 ** i;
        await sleep(delay);
      }
    }
    throw lastErr ?? new Error("Retry failed");
  }

  const options = attemptsOrOptions;

  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs =
    Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
      ? resolved.maxDelayMs
      : Number.POSITIVE_INFINITY;
  const jitter = resolved.jitter;
  const shouldRetry = options.shouldRetry ?? (() => true);
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      const retryAfterMs = options.retryAfterMs?.(err);
      const inferredRetryAfterMs =
        retryAfterMs === undefined && isRateLimitLikeError(err)
          ? extractRetryAfterMsFromError(err)
          : undefined;
      const resolvedRetryAfterMs = retryAfterMs ?? inferredRetryAfterMs;
      const hasRetryAfter =
        typeof resolvedRetryAfterMs === "number" && Number.isFinite(resolvedRetryAfterMs);
      const baseDelay = hasRetryAfter
        ? Math.max(resolvedRetryAfterMs, minDelayMs)
        : minDelayMs * 2 ** (attempt - 1);
      let delay = Math.min(baseDelay, maxDelayMs);
      delay = applyJitter(delay, jitter);
      delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });
      await sleep(delay);
    }
  }

  throw lastErr ?? new Error("Retry failed");
}
