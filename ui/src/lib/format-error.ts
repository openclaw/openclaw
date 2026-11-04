import { readMissingScopeError } from "@openclaw/gateway-client/browser";
import {
  collectErrorGraphCandidates,
  formatErrorMessage,
  readErrorCauses,
  readErrorName,
  stringifyNonErrorCause,
} from "@openclaw/normalization-core/error-coercion";
import { asNullableRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { redactToolDetail } from "./browser-redact.ts";
import { formatMissingScopeMessage } from "./gateway-errors.ts";

/** The message is complete UI text; the cause remains available to diagnostics. */
export class UserFacingError extends Error {}

// SyntaxError stays visible: users fix what JSON.parse rejects, such as Debug's RPC params.
const PROGRAMMING_ERROR_NAMES = new Set([
  "EvalError",
  "InternalError",
  "RangeError",
  "ReferenceError",
  "TypeError",
  "URIError",
]);

// Browsers report failed fetches and module loads as TypeError; these describe the connection.
const BROWSER_NETWORK_FAILURE =
  /^(?:failed to fetch|load failed|networkerror when|network error|the network connection|the internet connection|importing a module script failed|error loading dynamically imported module)/i;

// The string callers already pass as a fallback. Translated equivalents live in lazy catalogs,
// which render as raw keys on pages that have not loaded them.
const GENERIC_FAILURE_MESSAGE = "Request failed";

const reportedProgrammingErrors = new WeakSet<object>();

function isProgrammingError(value: unknown): value is Error {
  return (
    (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") &&
    PROGRAMMING_ERROR_NAMES.has(readErrorName(value)) &&
    !BROWSER_NETWORK_FAILURE.test(readStringField(asNullableRecord(value), "message") ?? "")
  );
}

/** Formatting runs on every render, so each thrown value reaches the console once. */
function reportProgrammingError(error: object): void {
  if (!reportedProgrammingErrors.has(error)) {
    reportedProgrammingErrors.add(error);
    console.error("[control-ui] programming error hidden from the UI:", error);
  }
}

/** Formats a failure for display; programming errors are diagnostics, not UI text. */
export function formatUiError(error: unknown, fallback = ""): string {
  if (error instanceof UserFacingError) {
    return redactToolDetail(error.message) || fallback;
  }
  const missingScope = readMissingScopeError(error);
  if (missingScope) {
    return redactToolDetail(
      formatMissingScopeMessage(missingScope.missingScope, "complete this request"),
    );
  }
  const programmingErrors = collectErrorGraphCandidates(error, readErrorCauses).filter(
    isProgrammingError,
  );
  if (programmingErrors.length > 0) {
    if (typeof error === "object" && error !== null) {
      reportProgrammingError(error);
    }
    if (programmingErrors[0] === error) {
      return fallback || GENERIC_FAILURE_MESSAGE;
    }
  }
  // A wrapper keeps its own message and its other causes.
  const message = programmingErrors.reduce(
    (text, cause) => text.replace(` | ${cause.message}`, ""),
    formatErrorMessage(error),
  );
  return redactToolDetail(message) || fallback;
}

/** Technical details are opt-in and redacted, never replaced by recovery copy. */
export function formatUiErrorDetails(error: unknown): string {
  const message = formatErrorMessage(error);
  const details = asNullableRecord(error)?.details;
  return redactToolDetail(
    details == null ? message : `${message}\n${stringifyNonErrorCause(details)}`,
  );
}

export function formatUiExternalText(value: string | null | undefined, fallback = ""): string {
  const text = value?.trim();
  return text ? redactToolDetail(text) : fallback;
}
