// Normalizes error objects for codes, names, messages, and redacted logs.
import {
  extractErrorCode,
  formatErrorMessage as formatSharedErrorMessage,
  formatErrorStackWithMessage,
} from "@openclaw/normalization-core/error-coercion";
import { redactSensitiveText } from "../logging/redact.js";
export {
  collectErrorGraphCandidates,
  extractErrorCode,
  formatErrorStackWithMessage,
  readErrorCauses,
  readErrorName,
} from "@openclaw/normalization-core/error-coercion";
export { hasErrnoCode, isErrno, isMissingPathError } from "./errno.js";

export function readErrorCause(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  // SAFETY: The object guard permits direct optional cause access without coercion.
  return (error as { cause?: unknown }).cause;
}

export function formatErrorMessage(err: unknown): string {
  return formatSharedErrorMessage(err, { redact: redactSensitiveText });
}

export function formatErrorMessageWithCode(err: unknown): string {
  return formatSharedErrorMessage(err, { includeCode: true, redact: redactSensitiveText });
}

export { toErrorObject } from "@openclaw/normalization-core/error-coercion";

export function formatUncaughtError(err: unknown): string {
  if (extractErrorCode(err) === "INVALID_CONFIG") {
    return formatErrorMessage(err);
  }
  if (err instanceof Error) {
    return redactSensitiveText(formatErrorStackWithMessage(err));
  }
  return formatErrorMessage(err);
}
