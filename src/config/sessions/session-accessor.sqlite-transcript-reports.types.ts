import type { Result } from "@openclaw/normalization-core/result";
import type { AssistantMessage } from "../../llm/types.js";
import type {
  TranscriptAppendRefusal,
  TranscriptMessageAppendResult,
} from "./session-accessor.sqlite-contract.js";
import type { PreparedTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.types.js";
import type { InternalSessionEntry } from "./types.js";

/** Selection and commit share the predecessor predicate; age alone never proves lost ownership. */
export function isStartupSessionSettlementCandidate(
  entry: InternalSessionEntry,
  processStartedAt: number,
): boolean {
  return (
    entry.status === "running" &&
    !entry.incognito &&
    Number.isFinite(entry.updatedAt) &&
    entry.updatedAt < processStartedAt &&
    (entry.archivedAt !== undefined ||
      (typeof entry.startedAt === "number" &&
        Number.isFinite(entry.startedAt) &&
        entry.startedAt < processStartedAt &&
        !entry.restartRecoveryRuns?.length &&
        !entry.subagentRecovery &&
        !entry.mainRestartRecovery &&
        !entry.pendingFinalDelivery &&
        !entry.pendingDeliveryNotice &&
        !entry.initializationPending &&
        !entry.restartRecoveryBeforeAgentReplyState &&
        !entry.restartRecoveryDeliveryReceiptState &&
        !entry.restartRecoveryDeliveryRunId &&
        !entry.restartRecoveryDeliverySourceRunId))
  );
}

export type StartupSessionObservation = {
  expected: Pick<
    InternalSessionEntry,
    "sessionId" | "lifecycleRevision" | "lifecycleRunId" | "updatedAt" | "startedAt" | "archivedAt"
  >;
  processStartedAt: number;
  endedAt: number;
  gatewayOwner: { owner: string; pid: number };
};
export type StartupSessionSettlement = { observation: StartupSessionObservation } & (
  | { kind: "archive" }
  | { kind: "interrupt"; runId: string; error: string; report: CustomMessageReportAppend }
);
export type StartupSessionSettlementOutcome = "archived" | "interrupted" | "retained" | "unchanged";

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

export type TranscriptReportWorkerOperations = {
  startupSettlement: {
    input: StartupSessionSettlement;
    output: Result<
      TranscriptReportCommit & { outcome: StartupSessionSettlementOutcome },
      TranscriptAppendRefusal
    >;
  };
  abortedPartial: {
    input: AbortedSessionTranscriptPartial & {
      preparedMessage: PreparedTranscriptMessageAppend<Record<string, unknown>>;
    };
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
  prepare: {
    input: TranscriptReportSelection;
    output: Result<PreparedTranscriptReport, TranscriptAppendRefusal>;
  };
  append: {
    input: Extract<SelectedTranscriptReport, { kind: "custom" }>;
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
  assistant: {
    input: Extract<TranscriptReport, { kind: "assistant" }> & {
      preparedMessage: PreparedTranscriptMessageAppend<
        Extract<TranscriptReport, { kind: "assistant" }>["message"]
      >;
    };
    output: Result<TranscriptReportCommit, TranscriptAppendRefusal>;
  };
};
