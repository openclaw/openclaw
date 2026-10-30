import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";

// Errors that Node reports only while resolving or opening a connection.
const PRE_CONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETDOWN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
]);
const MAX_CAUSE_DEPTH = 8;

function isPreConnectLeaf(candidate: unknown): boolean {
  const code = extractErrorCode(candidate)?.trim().toUpperCase();
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_DNS_RESOLVE_FAILED") {
    return true;
  }
  if (!code || !PRE_CONNECT_ERROR_CODES.has(code) || !candidate || typeof candidate !== "object") {
    return false;
  }
  // SAFETY: The guard above establishes a non-null object; syscall stays unknown until checked.
  const syscall = (candidate as { syscall?: unknown }).syscall;
  return syscall === "connect" || syscall === "getaddrinfo";
}

function provesPreConnect(candidate: unknown, depth: number): boolean {
  if (depth > MAX_CAUSE_DEPTH || !candidate || typeof candidate !== "object") {
    return false;
  }
  if (isPreConnectLeaf(candidate)) {
    return true;
  }
  // SAFETY: The guard above establishes a non-null object; both optional fields remain unknown.
  const { errors, cause } = candidate as { errors?: unknown; cause?: unknown };
  // Node aggregates one connect attempt per resolved address; each must prove it.
  if (Array.isArray(errors)) {
    return errors.length > 0 && errors.every((branch) => provesPreConnect(branch, depth + 1));
  }
  // Only a neutral wrapper, such as fetch's "fetch failed", may defer to its cause.
  return extractErrorCode(candidate) === undefined && provesPreConnect(cause, depth + 1);
}

/**
 * True only when a fetch rejection proves the connection was never opened, so no
 * request bytes were written. Resets, closed sockets and aborts stay unproven.
 */
export function isProvenPreConnectFetchFailure(error: unknown): boolean {
  return provesPreConnect(error, 0);
}
