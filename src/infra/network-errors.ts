import { extractErrorCode } from "./errors.js";

// Error codes that indicate transient network failures safe to retry.
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ERR_NETWORK",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
  "UND_ERR_DNS_RESOLVE_FAILED",
]);

const TRANSIENT_MESSAGE_RE =
  /fetch failed|socket hang up|getaddrinfo|network error|client network socket disconnected/i;

function getCode(err: unknown): string | undefined {
  const direct = extractErrorCode(err);
  if (direct) {
    return direct;
  }
  if (err && typeof err === "object") {
    const errno = (err as { errno?: unknown }).errno;
    if (typeof errno === "string") {
      return errno;
    }
  }
  return undefined;
}

/**
 * Returns true if `err` (or its `.cause` chain) looks like a
 * transient network failure that is safe to retry. Checks error
 * codes, error names, and a small set of message snippets.
 */
export function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current != null && !seen.has(current)) {
    seen.add(current);
    const code = getCode(current)?.toUpperCase();
    if (code && TRANSIENT_CODES.has(code)) {
      return true;
    }
    if (current instanceof Error) {
      if (current.name === "AbortError" || current.name === "TimeoutError") {
        return true;
      }
      if (TRANSIENT_MESSAGE_RE.test(current.message)) {
        return true;
      }
    }
    current =
      current && typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}
