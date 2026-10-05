import type { Result } from "@openclaw/normalization-core/result";
import type { AssistantMessage } from "../../llm/types.js";
import type {
  TranscriptAppendRefusal,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";

export type AbortedSessionTranscriptPartial = {
  runId: string;
  message: Record<string, unknown>;
  now?: number;
  expectedLifecycleRevision?: string | null;
};

export type AbortedSessionTranscriptPartialResult =
  | { skipped: true }
  | {
      skipped: false;
      append: TranscriptMessageAppendResult<Record<string, unknown>>;
      lifecycleRevision?: string;
      messageSeq?: number;
    };

export type CustomMessageReport = { customType: string; content: unknown; details?: unknown };
export type CustomMessageReportAppend = {
  customType: string;
  content: string;
  display: boolean;
  details?: unknown;
};
export type TranscriptReport =
  | { kind: "assistant"; message: AssistantMessage & { responseId: string } }
  | {
      kind: "custom";
      customTypes: readonly string[];
      suppressWhenAssistantRun?: string;
      /** Pure selection; a definite concurrent transcript change may repeat it. */
      selectReport: (
        latest: CustomMessageReport | undefined,
      ) => CustomMessageReportAppend | undefined;
    };

export type SelectedTranscriptReport =
  | Extract<TranscriptReport, { kind: "assistant" }>
  | { kind: "custom"; eventJson: string };

export type TranscriptReportSelection =
  | { kind: "assistant"; responseId: string }
  | Pick<
      Extract<TranscriptReport, { kind: "custom" }>,
      "kind" | "customTypes" | "suppressWhenAssistantRun"
    >;

export type PreparedTranscriptReport = {
  appendParentId: string | null;
  suppressed: boolean;
  latest: CustomMessageReport | undefined;
};

export type TranscriptReportCommit = {
  committed: boolean;
  projectionNeedsReconcile: boolean;
  cliHistoryChanged?: boolean;
  abortedPartial?: AbortedSessionTranscriptPartialResult;
  sessionEntryChanged?: boolean;
};

/** Set by the host on each write, right before it is sent: the CLI history owner still holds. */
type TranscriptReportCoverageGate = { cliHistoryOwnerConfirmed?: boolean };

export type TranscriptReportWorkerOperations = {
  abortedPartial: {
    input: AbortedSessionTranscriptPartial &
      TranscriptReportCoverageGate & {
        preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>;
      };
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
  prepare: {
    input: TranscriptReportSelection;
    output: Result<PreparedTranscriptReport, TranscriptAppendRefusal>;
  };
  append: {
    input: Extract<SelectedTranscriptReport, { kind: "custom" }> & TranscriptReportCoverageGate;
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
  assistant: {
    input: Extract<TranscriptReport, { kind: "assistant" }> &
      TranscriptReportCoverageGate & {
        preparedMessage: PreparedTranscriptMessageAppend<
          Extract<TranscriptReport, { kind: "assistant" }>["message"]
        >;
      };
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
};
