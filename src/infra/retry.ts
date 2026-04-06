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

const asFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

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

/**
 * Detect rate-limit-like errors by inspecting HTTP status codes on the error
 * object itself or nested under `response.status` / `response.statusCode`.
 */
export function isRateLimitLikeError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  const obj = err as Record<string, unknown>;

  const coerceStatus = (v: unknown): number | undefined => {
    if (typeof v === "number") {
      return v;
    }
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };

  const directStatus = coerceStatus(obj.status) ?? coerceStatus(obj.statusCode);
  if (directStatus === 429) {
    return true;
  }
  const resp = obj.response as Record<string, unknown> | undefined;
  if (resp) {
    const nestedStatus = coerceStatus(resp.status) ?? coerceStatus(resp.statusCode);
    if (nestedStatus === 429) {
      return true;
    }
  }
  const code = typeof obj.code === "string" ? obj.code.toUpperCase() : undefined;
  const message = typeof obj.message === "string" ? obj.message.toLowerCase() : "";
  return (
    code === "ERATELIMIT" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "THROTTLING_EXCEPTION" ||
    code === "TOO_MANY_REQUESTS" ||
    message.includes("rate limit") ||
    message.includes("429")
  );
}

/**
 * Parse an RFC 7231 HTTP-date string to a Unix timestamp in ms.
 * Supports all three IMF-fixdate, RFC-850, and asctime formats.
 */
function parseHttpDate(value: string): number | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();

  // IMF-fixdate  = day-name "," SP date1 SP time-of-day SP GMT
  // e.g. "Sat, 05 Apr 2025 12:00:05 GMT"
  const IMF_RE =
    /^[A-Z][a-z]{2},?\s+(\d{1,2})\s+([A-Z][a-z]{2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/i;
  const imfMatch = IMF_RE.exec(trimmed);
  if (imfMatch) {
    const [, day, monthStr, year, hour, minute, second] = imfMatch;
    const monthIdx = MONTH_MAP[monthStr.toLowerCase() as Lowercase<string>];
    if (monthIdx === undefined) {
      return undefined;
    }
    const d = new Date(Date.UTC(+year, monthIdx, +day, +hour, +minute, +second));
    return Number.isFinite(d.getTime()) ? d.getTime() : undefined;
  }

  // RFC-850    = day-name "," SP date2 SP time-of-day SP GMT
  // e.g. "Saturday, 05-Apr-25 12:00:05 GMT"
  const RFC850_RE =
    /^[A-Z][a-z]+,?\s+(\d{1,2})-([A-Z][a-z]{2})-(\d{2,4})\s+(\d{2}):(\d{2}):(\d{2})\s+GMT$/i;
  const rfc850Match = RFC850_RE.exec(trimmed);
  if (rfc850Match) {
    const [, day, monthStr, yearStr, hour, minute, second] = rfc850Match;
    const monthIdx = MONTH_MAP[monthStr.toLowerCase() as Lowercase<string>];
    if (monthIdx === undefined) {
      return undefined;
    }
    let year = +yearStr;
    if (year < 100) {
      year += year < 70 ? 2000 : 1900;
    }
    const d = new Date(Date.UTC(year, monthIdx, +day, +hour, +minute, +second));
    return Number.isFinite(d.getTime()) ? d.getTime() : undefined;
  }

  // asctime    = day-name SP date3 SP time-of-day SP year
  // e.g. "Sat Apr  5 12:00:05 2025"
  const ASCTIME_RE =
    /^[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/i;
  const asctimeMatch = ASCTIME_RE.exec(trimmed);
  if (asctimeMatch) {
    const [, monthStr, day, hour, minute, second, year] = asctimeMatch;
    const monthIdx = MONTH_MAP[monthStr.toLowerCase() as Lowercase<string>];
    if (monthIdx === undefined) {
      return undefined;
    }
    const d = new Date(Date.UTC(+year, monthIdx, +day, +hour, +minute, +second));
    return Number.isFinite(d.getTime()) ? d.getTime() : undefined;
  }

  return undefined;
}

const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
} as const;

const RETRY_AFTER_MESSAGE_RE =
  /retry[\s_-]*after[\s:=]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec(?:onds?)?|m|min(?:utes?)?)?/i;
const RETRY_AFTER_MS_KEY_RE = /retry[\s_-]*after[\s_-]*ms[\s:=]*(\d+(?:\.\d+)?)/i;

export function parseRetryAfterFromMessage(message: string): number | undefined {
  const msMatch = RETRY_AFTER_MS_KEY_RE.exec(message);
  if (msMatch) {
    const ms = Number(msMatch[1]);
    return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
  }
  const match = RETRY_AFTER_MESSAGE_RE.exec(message);
  if (!match) {
    return undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) {
    return undefined;
  }
  const unit = (match[2] ?? "s").toLowerCase();
  if (unit === "ms" || unit.startsWith("millisecond")) {
    return value;
  }
  if (unit === "m" || unit.startsWith("min")) {
    return value * 60_000;
  }
  // Default: seconds
  return value * 1000;
}

/**
 * Extract a retry delay (in milliseconds) from a rate-limit-like error.
 *
 * Priority:
 *   1. `err.retryAfterMs` (numeric, treated as milliseconds)
 *   2. `err.retryAfter` (numeric or string, treated as **seconds** per HTTP spec)
 *   3. `headers['retry-after']` on the error or nested `response.headers`
 *   4. Regex match in `err.message` (e.g. "retry after 3 seconds")
 */
export function extractRetryAfterMsFromError(err: unknown): number | undefined {
  if (!err || !isRateLimitLikeError(err)) {
    return undefined;
  }
  const obj = err as Record<string, unknown>;

  // 1. retryAfterMs — already milliseconds
  const retryAfterMs = asFiniteNumber(obj.retryAfterMs);
  if (retryAfterMs !== undefined && retryAfterMs >= 0) {
    return Math.round(retryAfterMs);
  }

  // 2. retryAfter — treat as seconds (HTTP Retry-After semantics)
  const retryAfterRaw = obj.retryAfter;
  const retryAfterNum =
    typeof retryAfterRaw === "string"
      ? asFiniteNumber(Number(retryAfterRaw))
      : asFiniteNumber(retryAfterRaw);
  if (retryAfterNum !== undefined && retryAfterNum >= 0) {
    return Math.round(retryAfterNum * 1000);
  }

  // 3. Headers
  const resolveHeaderValue = (headers: unknown): string | undefined => {
    if (!headers) {
      return undefined;
    }
    if (typeof (headers as { get?: unknown }).get === "function") {
      const raw = (headers as { get(k: string): unknown }).get("retry-after");
      return typeof raw === "string" ? raw : undefined;
    }
    if (typeof headers === "object" && headers !== null) {
      const h = headers as Record<string, unknown>;
      const value = h["retry-after"] ?? h["Retry-After"];
      return typeof value === "string" ? value : undefined;
    }
    return undefined;
  };
  const headerValue =
    resolveHeaderValue(obj.headers) ??
    resolveHeaderValue((obj.response as Record<string, unknown> | undefined)?.headers);
  if (headerValue) {
    const headerNum = Number(headerValue);
    if (Number.isFinite(headerNum) && headerNum >= 0) {
      return Math.round(headerNum * 1000);
    }
    // Handle HTTP-date format (RFC 7231)
    const httpDateMs = parseHttpDate(headerValue);
    if (httpDateMs !== undefined) {
      const deltaMs = httpDateMs - Date.now();
      if (deltaMs >= 0) {
        return Math.round(deltaMs);
      }
    }
  }

  // 4. Message text
  const message = typeof obj.message === "string" ? obj.message : undefined;
  if (message) {
    return parseRetryAfterFromMessage(message);
  }

  return undefined;
}

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

      const retryAfterMs = (() => {
        const explicit = options.retryAfterMs?.(err);
        if (typeof explicit === "number" && Number.isFinite(explicit)) {
          return explicit;
        }
        return extractRetryAfterMsFromError(err);
      })();
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
      const baseDelay = hasRetryAfter
        ? Math.max(retryAfterMs, minDelayMs)
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
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw lastErr ?? new Error("Retry failed");
}
