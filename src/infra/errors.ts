export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return String(code);
  }
  return undefined;
}

/**
 * Type guard for NodeJS.ErrnoException (any error with a `code` property).
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

/**
 * Check if an error has a specific errno code.
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}

export function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "Error";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

/**
 * Retryable network error codes — transient failures worth retrying.
 */
const RETRYABLE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT",
]);

/**
 * Unwrap the cause chain of a `TypeError("fetch failed")` and return
 * a human-readable description of the root network error.
 *
 * Example: `TypeError("fetch failed", { cause: Error("getaddrinfo ENOTFOUND foo.com") })`
 *  → `"ENOTFOUND: getaddrinfo ENOTFOUND foo.com"`
 *
 * Falls back to `formatErrorMessage(err)` for non-network errors.
 */
export function describeNetworkError(err: unknown): string {
  const root = unwrapCause(err);
  const code = extractErrorCode(root);
  const message = formatErrorMessage(root);
  return code ? `${code}: ${message}` : message;
}

/**
 * Determine whether a network error is worth retrying.
 * Returns `true` for transient failures (connection refused, reset, timeout).
 * Returns `false` for permanent failures (DNS ENOTFOUND, TLS errors).
 */
export function isRetryableNetworkError(err: unknown): boolean {
  const root = unwrapCause(err);
  const code = extractErrorCode(root);
  return code != null && RETRYABLE_CODES.has(code);
}

/**
 * Recursively unwrap `err.cause` to find the root cause.
 */
function unwrapCause(err: unknown): unknown {
  let current = err;
  while (current instanceof Error && current.cause != null) {
    current = current.cause;
  }
  return current;
}

export function formatUncaughtError(err: unknown): string {
  if (extractErrorCode(err) === "INVALID_CONFIG") {
    return formatErrorMessage(err);
  }
  if (err instanceof Error) {
    return err.stack ?? err.message ?? err.name;
  }
  return formatErrorMessage(err);
}
