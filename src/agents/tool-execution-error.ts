import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { attachInternalToolResultContentSource } from "../../packages/agent-core/src/internal-hooks.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
} from "../security/external-content.js";
import { isTrustedToolInputError } from "./tool-input-error.js";
import { readToolErrorField } from "./tool-result-error.js";

const TOOL_TIMEOUT_ERROR_CODES = new Set([
  "ERR_TIMEOUT",
  "ESOCKETTIMEDOUT",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const NETWORK_TOOL_ERROR_MAX_CHARS = 4_000;
const protectedNetworkToolErrors = new WeakSet<object>();
const protectedNetworkToolTimeoutErrors = new WeakSet<object>();

function hasStructuredToolTimeoutIdentity(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const name = readToolErrorField(current, "name");
    if (name === "TimeoutError") {
      return true;
    }
    const code = readToolErrorField(current, "code");
    if (typeof code === "string" && TOOL_TIMEOUT_ERROR_CODES.has(code.trim().toUpperCase())) {
      return true;
    }
    for (const key of ["reason", "status"] as const) {
      const value = readToolErrorField(current, key);
      const normalized = normalizeOptionalLowercaseString(value);
      if (normalized === "timeout" || normalized === "timed_out") {
        return true;
      }
      if (value && typeof value === "object") {
        pending.push(value);
      }
    }
    const cause = readToolErrorField(current, "cause");
    if (cause && typeof cause === "object") {
      pending.push(cause);
    }
  }
  return false;
}

/** Classify a thrown tool error without inferring cancellation from message text. */
export function resolveToolExecutionErrorKind(error: unknown): "failed" | "timed_out" {
  try {
    return (typeof error === "object" &&
      error !== null &&
      protectedNetworkToolTimeoutErrors.has(error)) ||
      hasStructuredToolTimeoutIdentity(error)
      ? "timed_out"
      : "failed";
  } catch {
    return "failed";
  }
}

/** Authenticates host-owned preflight failures before a tool reaches untrusted network data. */
export function isTrustedToolExecutionPreflightError(error: unknown): boolean {
  return isTrustedSecretSurfaceUnavailableError(error) || isTrustedToolInputError(error);
}

/** Format a tool error without allowing hostile getters to escape observability. */
export function formatToolExecutionErrorMessage(error: unknown, fallback: string): string {
  try {
    return formatErrorMessage(error) || fallback;
  } catch {
    return fallback;
  }
}

/** Protect network-controlled failures once while preserving trusted cancellation and identity. */
export function protectNetworkToolExecutionError(
  error: unknown,
  fallback: string,
  signal?: AbortSignal,
): unknown {
  if (
    (signal?.aborted && error === signal.reason) ||
    isTrustedToolExecutionPreflightError(error) ||
    (typeof error === "object" && error !== null && protectedNetworkToolErrors.has(error))
  ) {
    return error;
  }
  const timedOut = resolveToolExecutionErrorKind(error) === "timed_out";
  const { text: message } = truncateSanitizedExternalContent(
    formatToolExecutionErrorMessage(error, fallback),
    NETWORK_TOOL_ERROR_MAX_CHARS,
  );
  // Error coercion traverses inherited causes; shadow them before preserving safe identity.
  const protectedError = new Error(wrapExternalContent(message, { source: "api" }));
  Object.defineProperty(protectedError, "cause", { value: undefined });
  try {
    if (error instanceof Error) {
      const prototype: object | null = Object.getPrototypeOf(error);
      const safeTypes = [TypeError, RangeError, ReferenceError, SyntaxError, URIError, EvalError];
      if (safeTypes.some((kind) => prototype === kind.prototype)) {
        Object.setPrototypeOf(protectedError, prototype);
      }
      for (const key of ["name", "code", "status"] as const) {
        const value: unknown = Object.getOwnPropertyDescriptor(error, key)?.value;
        const valid =
          key === "status"
            ? typeof value === "number" && Number.isSafeInteger(value)
            : typeof value === "string" &&
              /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) &&
              (key === "name" || value === value.toUpperCase());
        if (valid) {
          Object.defineProperty(protectedError, key, { configurable: true, value });
        }
      }
    }
  } catch {
    // Hostile reflection must never replace the already-protected network error.
  }
  protectedNetworkToolErrors.add(protectedError);
  // Dispatchers rethrow this error under their own tool; keep its network origin for turn taint.
  attachInternalToolResultContentSource(protectedError, "network");
  if (timedOut) {
    protectedNetworkToolTimeoutErrors.add(protectedError);
  }
  return protectedError;
}
