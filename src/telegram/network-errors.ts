import {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
} from "../infra/errors.js";

const TELEGRAM_NETWORK_ORIGIN = Symbol("openclaw.telegram.network-origin");

const RECOVERABLE_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ECONNABORTED",
  "ERR_NETWORK",
]);

/**
 * Error codes that are safe to retry for non-idempotent send operations (e.g. sendMessage).
 *
 * These represent failures that occur *before* the request reaches Telegram's servers,
 * meaning the message was definitely not delivered and it is safe to retry.
 *
 * Contrast with RECOVERABLE_ERROR_CODES which includes codes like ECONNRESET and ETIMEDOUT
 * that can fire *after* Telegram has already received and delivered a message — retrying
 * those would cause duplicate messages.
 */
const PRE_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED", // Server actively refused the connection (never reached Telegram)
  "ENOTFOUND", // DNS resolution failed (never sent)
  "EAI_AGAIN", // Transient DNS failure (never sent)
  "ENETUNREACH", // No route to host (never sent)
  "EHOSTUNREACH", // Host unreachable (never sent)
]);

const RECOVERABLE_ERROR_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
]);

const ALWAYS_RECOVERABLE_MESSAGES = new Set(["fetch failed", "typeerror: fetch failed"]);
const GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE =
  /^network request(?:\s+for\s+["']?[^"']+["']?)?\s+failed\s+after\b.*[!.]?$/i;

const RECOVERABLE_MESSAGE_SNIPPETS = [
  "undici",
  "network error",
  "network request",
  "client network socket disconnected",
  "socket hang up",
  "getaddrinfo",
  "timeout", // catch timeout messages not covered by error codes/names
  "timed out", // grammY getUpdates returns "timed out after X seconds" (not matched by "timeout")
];

function collectTelegramErrorCandidates(err: unknown) {
  return collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [current.cause, current.reason];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    if (readErrorName(current) === "HttpError") {
      nested.push(current.error);
    }
    return nested;
  });
}

function normalizeCode(code?: string): string {
  return code?.trim().toUpperCase() ?? "";
}

function getErrorCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const errno = (err as { errno?: unknown }).errno;
  if (typeof errno === "string") {
    return errno;
  }
  if (typeof errno === "number") {
    return String(errno);
  }
  return undefined;
}

export type TelegramNetworkErrorContext = "polling" | "send" | "webhook" | "unknown";
export type TelegramNetworkErrorOrigin = {
  method?: string | null;
  url?: string | null;
};

function normalizeTelegramNetworkMethod(method?: string | null): string | null {
  const trimmed = method?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.toLowerCase();
}

export function tagTelegramNetworkError(err: unknown, origin: TelegramNetworkErrorOrigin): void {
  if (!err || typeof err !== "object") {
    return;
  }
  Object.defineProperty(err, TELEGRAM_NETWORK_ORIGIN, {
    value: {
      method: normalizeTelegramNetworkMethod(origin.method),
      url: typeof origin.url === "string" && origin.url.trim() ? origin.url : null,
    } satisfies TelegramNetworkErrorOrigin,
    configurable: true,
  });
}

export function getTelegramNetworkErrorOrigin(err: unknown): TelegramNetworkErrorOrigin | null {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const origin = (candidate as Record<PropertyKey, unknown>)[TELEGRAM_NETWORK_ORIGIN];
    if (!origin || typeof origin !== "object") {
      continue;
    }
    const method = "method" in origin && typeof origin.method === "string" ? origin.method : null;
    const url = "url" in origin && typeof origin.url === "string" ? origin.url : null;
    return { method, url };
  }
  return null;
}

export function isTelegramPollingNetworkError(err: unknown): boolean {
  return getTelegramNetworkErrorOrigin(err)?.method === "getupdates";
}

/**
 * Returns true if the error is a Telegram 429 Too Many Requests response with a
 * retry_after hint. Telegram rate limit responses are safe to retry because the
 * server explicitly rejected the request before processing it — the message was
 * never delivered.
 */
export function isTelegramRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  // grammY / direct Telegram API shape: { parameters: { retry_after: number } }
  // Also handles nested response/error shapes via candidate traversal.
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const params = (candidate as { parameters?: unknown }).parameters;
    if (params && typeof params === "object" && "retry_after" in params) {
      return true;
    }
    // grammY HttpError shape: { error_code: 429 } or message containing "429"
    const errorCode = (candidate as { error_code?: unknown }).error_code;
    if (errorCode === 429) {
      return true;
    }
    const msg = formatErrorMessage(candidate);
    if (/\b429\b/.test(msg)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the error is safe to retry for a non-idempotent Telegram send operation
 * (e.g. sendMessage). Only matches errors that are guaranteed to have occurred *before*
 * the request reached Telegram's servers, preventing duplicate message delivery.
 *
 * This includes:
 * - Pre-connect network errors (ECONNREFUSED, ENOTFOUND, etc.) — request never left the client
 * - Telegram 429 Too Many Requests — server explicitly rejected before processing
 * - grammY "Network request failed after N attempts" envelope — library-level retry exhausted
 *   with an underlying network error; the message was not delivered
 *
 * Use this instead of isRecoverableTelegramNetworkError for sendMessage/sendPhoto/etc.
 * calls where a retry would create a duplicate visible message.
 */
export function isSafeToRetrySendError(err: unknown): boolean {
  if (!err) {
    return false;
  }
  // 429 rate limit: Telegram rejected the request — message was not delivered, safe to retry.
  if (isTelegramRateLimitError(err)) {
    return true;
  }
  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && PRE_CONNECT_ERROR_CODES.has(code)) {
      return true;
    }
    // grammY "Network request for '<method>' failed after N attempts." — underlying network
    // error that prevented delivery; safe to retry at the outer send level.
    const message = formatErrorMessage(candidate).trim();
    if (message && GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE.test(message)) {
      return true;
    }
  }
  return false;
}

function hasTelegramErrorCode(err: unknown, matches: (code: number) => boolean): boolean {
  for (const candidate of collectTelegramErrorCandidates(err)) {
    if (!candidate || typeof candidate !== "object" || !("error_code" in candidate)) {
      continue;
    }
    const code = (candidate as { error_code: unknown }).error_code;
    if (typeof code === "number" && matches(code)) {
      return true;
    }
  }
  return false;
}

/** Returns true for HTTP 5xx server errors (error may have been processed). */
export function isTelegramServerError(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code >= 500);
}

/** Returns true for HTTP 4xx client errors (Telegram explicitly rejected, not applied). */
export function isTelegramClientRejection(err: unknown): boolean {
  return hasTelegramErrorCode(err, (code) => code >= 400 && code < 500);
}

export function isRecoverableTelegramNetworkError(
  err: unknown,
  options: { context?: TelegramNetworkErrorContext; allowMessageMatch?: boolean } = {},
): boolean {
  if (!err) {
    return false;
  }
  const allowMessageMatch =
    typeof options.allowMessageMatch === "boolean"
      ? options.allowMessageMatch
      : options.context !== "send";

  for (const candidate of collectTelegramErrorCandidates(err)) {
    const code = normalizeCode(getErrorCode(candidate));
    if (code && RECOVERABLE_ERROR_CODES.has(code)) {
      return true;
    }

    const name = readErrorName(candidate);
    if (name && RECOVERABLE_ERROR_NAMES.has(name)) {
      return true;
    }

    const message = formatErrorMessage(candidate).trim().toLowerCase();
    if (message && ALWAYS_RECOVERABLE_MESSAGES.has(message)) {
      return true;
    }
    if (message && GRAMMY_NETWORK_REQUEST_FAILED_AFTER_RE.test(message)) {
      return true;
    }
    if (allowMessageMatch && message) {
      if (RECOVERABLE_MESSAGE_SNIPPETS.some((snippet) => message.includes(snippet))) {
        return true;
      }
    }
  }

  return false;
}
