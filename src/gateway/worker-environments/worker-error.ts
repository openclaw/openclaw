import { projectDiagnosticValue } from "@openclaw/ai/diagnostics";
import { projectProviderError } from "@openclaw/ai/internal/shared";
import { stableStringify } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage, formatErrorMessageWithCode } from "../../infra/errors.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { extractErrorHttpStatus, parseApiErrorInfo } from "../../shared/assistant-error-format.js";

function boundWorkerErrorText(text: string, maxChars: number): string {
  const redacted = redactSensitiveText(text, { mode: "tools" }).replace(/\s+/g, " ").trim();
  const message = redacted || "unknown error";
  const limit = Math.max(0, Math.floor(maxChars));
  const marker = " ... ";
  if (message.length <= limit || limit <= marker.length) {
    return truncateUtf16Safe(message, limit);
  }
  // Keep the operation context and terminal diagnosis when a provider's output is bounded again.
  const headChars = Math.floor((limit - marker.length) / 2);
  const tailChars = limit - marker.length - headChars;
  return `${sliceUtf16Safe(message, 0, headChars).trimEnd()}${marker}${sliceUtf16Safe(message, -tailChars).trimStart()}`.trim();
}

/** Formats a redacted worker error graph within a fixed display bound. */
export function boundedWorkerError(error: unknown, maxChars = 1_024): string {
  return boundWorkerErrorText(formatErrorMessage(error), maxChars);
}

/** Includes the outer error code while preserving the standard worker diagnostic bound. */
export function boundedWorkerErrorWithCode(error: unknown, maxChars = 1_024): string {
  return boundWorkerErrorText(formatErrorMessageWithCode(error), maxChars);
}

/** Preserve provider classification inside the existing bounded inference error text. */
export function formatWorkerInferenceError(error: unknown): string {
  const snapshot = projectDiagnosticValue(error);
  const projected = projectProviderError(snapshot);
  const record = asOptionalRecord(snapshot);
  const response = asOptionalRecord(record?.response);
  const status = [
    record?.status,
    record?.statusCode,
    response?.status,
    response?.statusCode,
    extractErrorHttpStatus(projected.errorMessage)?.code,
  ].find(
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599,
  );
  const body =
    record?.errorBody ?? record?.body ?? response?.body ?? response?.data ?? record?.error;
  // The display projection clips bodies; extract classification from the complete
  // redacted snapshot so a long body cannot turn billing or context errors into retries.
  const info =
    parseApiErrorInfo(projected.errorMessage) ??
    parseApiErrorInfo(typeof body === "string" ? body : stableStringify(body)) ??
    parseApiErrorInfo(projected.errorBody);
  const code = info?.code ?? projected.errorCode;
  const type = projected.errorType ?? info?.type;
  if (!code && !type && status === undefined) {
    return boundedWorkerError(snapshot, 256);
  }
  const details = {
    ...(code ? { code: boundedWorkerError(code, 64) } : {}),
    ...(type ? { type: boundedWorkerError(type, 64) } : {}),
    message: boundedWorkerError(
      info?.message ??
        extractErrorHttpStatus(projected.errorMessage)?.rest ??
        projected.errorMessage,
      256,
    ),
  };
  const prefix = status === undefined ? "" : `${status}: `;
  const encode = () => `${prefix}${JSON.stringify({ error: details })}`;
  let encoded = encode();
  // Clip text before JSON encoding so escaping cannot break the terminal schema
  // or destroy the code/type needed by both failover and chat history.
  for (const field of ["message", "type", "code"] as const) {
    const value = details[field];
    if (encoded.length > 256 && value) {
      details[field] = boundWorkerErrorText(
        value,
        Math.max(0, value.length - (encoded.length - 256)),
      );
      encoded = encode();
    }
  }
  return encoded;
}
