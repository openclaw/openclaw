/**
 * Unified provider error handler for OpenClaw.
 * Parses HTTP error responses from AI providers and implements retry with backoff.
 */

export type ProviderErrorCategory =
  | "rate-limit"
  | "resource-exhaustion"
  | "auth"
  | "client-error"
  | "unknown";

export interface ProviderError {
  provider: string;
  httpStatus: number;
  category: ProviderErrorCategory;
  retryAfterMs: number | null;
  message: string;
  retryable: boolean;
  raw: unknown;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  backoffMultiplier: 2.0,
};

function capitalizeFirst(s: string): string {
  if (s.length === 0) {
    return s;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null || headerValue.trim() === "") {
    return null;
  }

  const numeric = parseInt(headerValue.trim(), 10);
  if (!isNaN(numeric) && /^\d+$/.test(headerValue.trim())) {
    return Math.max(0, numeric * 1000);
  }

  const parsed = Date.parse(headerValue);
  if (!isNaN(parsed)) {
    return Math.max(0, parsed - Date.now());
  }

  return null;
}

export async function parseProviderError(
  provider: string,
  response: Response,
): Promise<ProviderError> {
  const label = capitalizeFirst(provider);
  const httpStatus = response.status;

  let raw: unknown = null;
  try {
    const cloned = response.clone();
    raw = await cloned.json();
  } catch {
    // parse failure — leave raw as null
  }

  let category: ProviderErrorCategory;
  let retryable: boolean;
  let retryAfterMs: number | null = null;
  let message: string;

  if (httpStatus === 429) {
    category = "rate-limit";
    retryable = true;
    retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs !== null) {
      const seconds = Math.round(retryAfterMs / 1000);
      message = `${label} Rate limited. Retrying in ${seconds}s...`;
    } else {
      message = `${label} Rate limited. Retrying with backoff...`;
    }
  } else if (httpStatus === 503) {
    category = "resource-exhaustion";
    retryable = true;
    retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs !== null) {
      const seconds = Math.round(retryAfterMs / 1000);
      message = `${label} Resource exhausted. Retrying in ${seconds}s...`;
    } else {
      message = `${label} Resource exhausted. Retrying with backoff...`;
    }
  } else if (httpStatus === 401) {
    category = "auth";
    retryable = false;
    retryAfterMs = null;
    message = `${label} Authentication failed (401). Check API key.`;
  } else if (httpStatus === 403) {
    category = "auth";
    retryable = false;
    retryAfterMs = null;
    message = `${label} Access denied (403).`;
  } else if (httpStatus === 400) {
    category = "client-error";
    retryable = false;
    retryAfterMs = null;
    message = `${label} Bad request (400).`;
  } else if (httpStatus === 500 || httpStatus === 502 || httpStatus === 504) {
    category = "resource-exhaustion";
    retryable = true;
    retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    if (retryAfterMs !== null) {
      const seconds = Math.round(retryAfterMs / 1000);
      message = `${label} Server error (${httpStatus}). Retrying in ${seconds}s...`;
    } else {
      message = `${label} Server error (${httpStatus}). Retrying with backoff...`;
    }
  } else {
    category = "unknown";
    retryable = false;
    retryAfterMs = null;
    message = `${label} Unexpected error (HTTP ${httpStatus}).`;
  }

  return {
    provider,
    httpStatus,
    category,
    retryAfterMs,
    message,
    retryable,
    raw,
  };
}

function isProviderError(value: unknown): value is ProviderError {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    "httpStatus" in value &&
    "category" in value &&
    "retryable" in value
  );
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  error: ProviderError,
  onRetry?: (attempt: number, maxRetries: number, delayMs: number, error: ProviderError) => void,
): Promise<T> {
  if (!isProviderError(error) || !error.retryable) {
    throw error;
  }

  const { maxRetries, baseDelayMs, maxDelayMs, backoffMultiplier } = policy;

  // Attempt 1
  const firstDelayMs =
    error.retryAfterMs !== null
      ? error.retryAfterMs
      : Math.min(baseDelayMs * Math.pow(backoffMultiplier, 0), maxDelayMs);

  onRetry?.(1, maxRetries, firstDelayMs, error);
  await new Promise<void>((resolve) => setTimeout(resolve, firstDelayMs));

  let lastError: ProviderError = error;
  try {
    return await fn();
  } catch (err: unknown) {
    if (!isProviderError(err)) {
      throw err;
    }
    if (!err.retryable) {
      throw err;
    }
    lastError = err;
  }

  // Attempts 2..maxRetries
  for (let attempt = 2; attempt <= maxRetries; attempt++) {
    const delayMs =
      lastError.retryAfterMs !== null
        ? lastError.retryAfterMs
        : Math.min(baseDelayMs * Math.pow(backoffMultiplier, attempt - 1), maxDelayMs);

    onRetry?.(attempt, maxRetries, delayMs, lastError);
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

    try {
      return await fn();
    } catch (err: unknown) {
      if (!isProviderError(err)) {
        throw err;
      }
      if (!err.retryable) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError;
}
