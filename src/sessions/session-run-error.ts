import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { renderAssistantRequestFailureCopy } from "../agents/failover/assistant-request-failure-copy.js";
import { renderCodexAppServerFailureCopy } from "../agents/failover/user-copy.js";
import {
  appendSessionTranscriptReport,
  type SessionTranscriptWriteScope,
} from "../config/sessions/session-accessor.js";
import type { CustomMessageReportAppend } from "../config/sessions/session-accessor.sqlite-transcript-reports.types.js";
import type { SessionEntryCurrentCheck } from "../config/sessions/session-entry-current.types.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { classifyGatewayStorageFailure } from "../infra/sqlite-error-diagnostics.js";
import { sanitizeSessionRunError } from "./session-run-error-format.js";
import { STATE_CONTENTION_SUMMARY } from "./session-run-error-presentation.js";

const RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE = "run-failed-before-reply";

type GatewaySessionRunFailure = {
  target: SessionTranscriptWriteScope & { sessionId: string };
  runId: string;
  error: unknown;
  errorKind?: "state_contention";
  suppressErrorNotice?: boolean;
  assertCommitAllowed?: () => void;
  sessionEntryCurrent?: SessionEntryCurrentCheck;
};

export async function recordGatewaySessionRunFailure(
  params: GatewaySessionRunFailure,
): Promise<void> {
  const { runId } = params;
  const storageFailure = classifyGatewayStorageFailure(params.error);
  const error = truncateUtf16Safe(sanitizeSessionRunError(params.error), 512) || "unknown error";
  const report: CustomMessageReportAppend = {
    customType: RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE,
    content:
      params.errorKind === "state_contention"
        ? STATE_CONTENTION_SUMMARY
        : (renderAssistantRequestFailureCopy({ storageFailure }) ??
          renderCodexAppServerFailureCopy(error) ??
          `Your request couldn't be completed: ${error}`),
    display: params.suppressErrorNotice !== true,
    excludeFromContext: true,
    details: { runId, error, ...(params.errorKind ? { errorKind: params.errorKind } : {}) },
  };
  const result = await withSessionTranscriptWriteAssertion(
    params.target,
    () => params.assertCommitAllowed?.(),
    () =>
      appendSessionTranscriptReport(
        params.target,
        {
          kind: "custom",
          customTypes: [RUN_FAILED_BEFORE_REPLY_TRANSCRIPT_TYPE],
          selectReport: (latest) => {
            params.assertCommitAllowed?.();
            return isRecord(latest?.details) && latest.details.runId === runId ? undefined : report;
          },
        },
        { sessionEntryCurrent: params.sessionEntryCurrent },
      ),
  );
  if (!result.ok) {
    throw new Error(`Failed run notice could not be appended: ${result.error.code}`);
  }
}
