import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionRunStatus } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { renderUserFacingText } from "../agents/embedded-agent-helpers/user-facing-text.js";
import {
  appendSessionTranscriptReport,
  type SessionTranscriptWriteScope,
} from "../config/sessions/session-accessor.js";
import { appendSessionTranscriptReportNative } from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { redactSensitiveText } from "../logging/redact.js";
import { STATE_CONTENTION_SUMMARY } from "./session-run-error-presentation.js";

const SESSION_RUN_ERROR_MAX_CHARS = 160;
const RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE = "run-failed-before-reply";

function sanitizeSessionRunError(error: unknown): string {
  const text = renderUserFacingText(error, { errorContext: true }).replace(/\s+/g, " ").trim();
  return redactSensitiveText(text, { mode: "tools" });
}

/** Shared failure receipt; optional settlement joins the receipt's synchronous transaction. */
export async function recordGatewaySessionRunFailure(params: {
  target: SessionTranscriptWriteScope & { sessionId: string };
  runId: string;
  error: unknown;
  errorKind?: "state_contention";
  status?: "failed" | "timeout";
  timeoutPartialText?: string;
  assertCommitAllowed?: () => void;
  settleStartupSession?: () => undefined;
}): Promise<void> {
  const { runId } = params;
  const error = truncateUtf16Safe(sanitizeSessionRunError(params.error), 512) || "unknown error";
  // One existing custom report keeps the partial and its outcome inseparable.
  // Older readers already replay this format; partial text remains quoted data,
  // rather than an injected assistant message that they would filter out.
  const timeoutContent =
    "This turn timed out and may have performed work before it stopped." +
    (params.timeoutPartialText?.trim()
      ? `\n\nUnfinished assistant output (recorded text, not a completion claim):\n${JSON.stringify(params.timeoutPartialText)}`
      : "");
  const append = params.settleStartupSession
    ? appendSessionTranscriptReportNative
    : appendSessionTranscriptReport;
  const result = await withSessionTranscriptWriteAssertion(
    params.target,
    () => params.assertCommitAllowed?.(),
    () =>
      append(params.target, {
        kind: "custom",
        customTypes: [RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE],
        // Partial output does not establish a completed turn. Keep its timeout outcome visible.
        suppressWhenAssistantRun: params.status === "timeout" ? undefined : runId,
        selectReport: (latest) => {
          params.assertCommitAllowed?.();
          params.settleStartupSession?.();
          params.assertCommitAllowed?.();
          if (isRecord(latest?.details) && latest.details.runId === runId) {
            return undefined;
          }
          return {
            customType: RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE,
            content:
              params.status === "timeout"
                ? timeoutContent
                : params.errorKind === "state_contention"
                  ? STATE_CONTENTION_SUMMARY
                  : `This turn ended before a reply: ${error}`,
            display: true,
            details: { runId, error, ...(params.errorKind ? { errorKind: params.errorKind } : {}) },
          };
        },
      }),
  );
  if (!result.ok) {
    throw new Error(`Failed run notice could not be appended: ${result.error.code}`);
  }
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
  const error = sanitizeSessionRunError(outcome.error);
  if (error.length <= SESSION_RUN_ERROR_MAX_CHARS) {
    return error || undefined;
  }
  // Nested failure wrappers must leave room for the terminal diagnosis in session rows.
  const marker = " ... ";
  const headChars = Math.floor((SESSION_RUN_ERROR_MAX_CHARS - marker.length) / 3);
  const tailChars = SESSION_RUN_ERROR_MAX_CHARS - marker.length - headChars;
  return `${sliceUtf16Safe(error, 0, headChars).trimEnd()}${marker}${sliceUtf16Safe(error, -tailChars).trimStart()}`;
}
