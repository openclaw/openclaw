import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";
import {
  appendSessionTranscriptReport,
  type SessionTranscriptWriteScope,
} from "../config/sessions/session-accessor.js";
import { redactSensitiveText } from "../logging/redact.js";
import {
  RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE,
  RUN_FAILURE_ERROR_MAX_CHARS,
  RUN_FAILURE_NOTICE_PREFIX,
} from "../shared/session-run-error.js";

const SESSION_RUN_ERROR_MAX_CHARS = 160;

function sanitizeSessionRunError(error: unknown): string {
  const text = renderUserFacingText(error, { errorContext: true }).trim();
  return redactSensitiveText(text, { mode: "tools" });
}

/** Shared failure receipt; optional settlement joins the receipt's synchronous transaction. */
export async function recordGatewaySessionRunFailure(params: {
  target: SessionTranscriptWriteScope & { sessionId: string };
  runId: string;
  error: unknown;
  assertCommitAllowed?: () => void;
  settleSession?: () => undefined;
}): Promise<void> {
  const { runId } = params;
  const sanitized = sanitizeSessionRunError(params.error) || "unknown error";
  const marker = "\n\n[Error truncated; search Gateway logs by run ID for more detail.]";
  const error =
    sanitized.length > RUN_FAILURE_ERROR_MAX_CHARS
      ? truncateUtf16Safe(sanitized, RUN_FAILURE_ERROR_MAX_CHARS - marker.length) + marker
      : sanitized;
  const result = await appendSessionTranscriptReport(params.target, {
    kind: "custom",
    customTypes: [RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE],
    suppressWhenAssistantRun: runId,
    selectReport: (latest) => {
      params.assertCommitAllowed?.();
      params.settleSession?.();
      params.assertCommitAllowed?.();
      if (isRecord(latest?.details) && latest.details.runId === runId) {
        return undefined;
      }
      return {
        customType: RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE,
        content: `${RUN_FAILURE_NOTICE_PREFIX}${error}`,
        display: true,
        details: { runId, error },
      };
    },
  });
  if (!result.ok) {
    throw new Error(`Failed run notice could not be appended: ${result.error.code}`);
  }
}

export function resolveSessionRunError(
  outcome: { error?: string },
  status: SessionRunStatus,
): string | undefined {
  if (
    (status !== "failed" && status !== "timeout") ||
    typeof outcome.error !== "string" ||
    !outcome.error.trim()
  ) {
    return undefined;
  }
  const error = sanitizeSessionRunError(outcome.error).replace(/\s+/g, " ").trim();
  if (error.length <= SESSION_RUN_ERROR_MAX_CHARS) {
    return error || undefined;
  }
  // Nested failure wrappers must leave room for the terminal diagnosis in session rows.
  const marker = " ... ";
  const headChars = Math.floor((SESSION_RUN_ERROR_MAX_CHARS - marker.length) / 3);
  const tailChars = SESSION_RUN_ERROR_MAX_CHARS - marker.length - headChars;
  return `${sliceUtf16Safe(error, 0, headChars).trimEnd()}${marker}${sliceUtf16Safe(error, -tailChars).trimStart()}`;
}
