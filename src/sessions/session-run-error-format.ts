import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { sanitizeUserFacingText } from "../agents/embedded-agent-helpers/sanitize-user-facing-text.js";
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";
import { renderStorageFailureSummary } from "../agents/failover/assistant-request-failure-copy.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import { redactSensitiveText } from "../logging/redact.js";
import { STATE_CONTENTION_SUMMARY } from "./session-run-error-presentation.js";

const SESSION_RUN_ERROR_MAX_CHARS = 160;

function sanitizeErrorText(text: string): string {
  return redactSensitiveText(text.replace(/\s+/g, " ").trim(), { mode: "tools" });
}

export function sanitizeSessionRunError(error: unknown): string {
  // Display copy can replace or truncate the cause before the diagnostic bound applies.
  return sanitizeErrorText(
    sanitizeUserFacingText(formatErrorMessage(error), { errorContext: true }),
  );
}

export function truncateSessionRunError(
  error: string,
  maxChars = SESSION_RUN_ERROR_MAX_CHARS,
): string {
  if (error.length <= maxChars) {
    return error;
  }
  // Keep both the operation and terminal diagnosis when warnings fill the middle.
  const marker = " ... ";
  const headChars = Math.floor((maxChars - marker.length) / 3);
  const tailChars = maxChars - marker.length - headChars;
  return `${sliceUtf16Safe(error, 0, headChars).trimEnd()}${marker}${sliceUtf16Safe(error, -tailChars).trimStart()}`;
}

export function resolveSessionRunError(
  outcome: { error?: string; errorKind?: unknown },
  status: SessionRunStatus,
): string | undefined {
  if (
    (status !== "failed" && status !== "timeout") ||
    typeof outcome.error !== "string" ||
    !outcome.error.trim()
  ) {
    return undefined;
  }
  if (outcome.errorKind === "state_contention") {
    return STATE_CONTENTION_SUMMARY;
  }
  const error =
    renderStorageFailureSummary(classifyGatewayStorageFailure(outcome.error)) ??
    sanitizeErrorText(renderUserFacingText(outcome.error, { errorContext: true }));
  return truncateSessionRunError(error) || undefined;
}
