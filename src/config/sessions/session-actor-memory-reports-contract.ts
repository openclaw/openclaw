import type { Result } from "@openclaw/normalization-core/result";
import type {
  WorkerTranscriptCommitInput,
  WorkerTranscriptCommitOutcome,
} from "../../gateway/worker-environments/transcript-commit-store.worker-contract.js";
import type {
  ApplyTranscriptCommitResult,
  CommittedAgentMessage,
  TranscriptCommitInput,
} from "../../gateway/worker-environments/transcript-commit.types.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import type {
  PreparedTranscriptReport,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import type { SessionTranscriptManualTrimResult } from "./session-accessor.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type {
  SessionMessageRewriteSelection,
  SessionMessageRewriteSnapshot,
  SessionMessageRewriteCommitted,
  SessionTranscriptCorrectionCommitted,
  SessionTranscriptCorrectionInput,
} from "./session-transcript-mutation.types.js";

export type SessionActorMemoryWorkerTranscriptLedger = {
  environmentId: string;
  nextSeq: number;
  receipts: Map<number, { requestHash: string; outcome: WorkerTranscriptCommitOutcome }>;
};

type Target = { scope: SessionTranscriptWriteScope & { sessionId: string } };
export type SessionActorMemoryReportsReads = {
  "session.transcript.messageFacts": {
    input: Target & { idempotencyKeys: readonly string[]; sourceRunId?: string };
    output: {
      version: SessionTranscriptContextVersion;
      facts: Awaited<
        ReturnType<
          import("./session-accessor.types.js").SessionTranscriptWriteLockAccessorContext["readMessageFacts"]
        >
      >;
    };
  };
  "session.rewrite.prepare": {
    input: Target & Pick<SessionMessageRewriteSelection, "target" | "expectedEntry">;
    output: SessionMessageRewriteSnapshot | null;
  };
  "session.report.prepare": {
    input: Target & { selection: TranscriptReportWorkerOperations["prepare"]["input"] };
    output: Result<
      { facts: PreparedTranscriptReport; version: SessionTranscriptContextVersion },
      TranscriptAppendRefusal
    >;
  };
  "session.correction.prepare": {
    input: Target & { afterSeq?: number };
    output: {
      rows: Array<{ seq: number; eventJson: string }>;
      version: SessionTranscriptContextVersion;
    };
  };
};
export type SessionActorMemoryReportsWrites = {
  [Key in "assistant" | "abortedPartial" as `session.report.${Key}`]: {
    input: Target & { report: TranscriptReportWorkerOperations[Key]["input"] };
    output: TranscriptReportWorkerOperations[Key]["output"];
  };
} & {
  "session.event.append": {
    input: Target & { eventJson: string };
    output: boolean;
  };
  "session.report.append": {
    input: Target & {
      version: SessionTranscriptContextVersion;
      report: TranscriptReportWorkerOperations["append"]["input"];
    };
    output: TranscriptReportWorkerOperations["append"]["output"];
  };
  "session.rewrite.commit": {
    input: SessionActorMemoryReportsReads["session.rewrite.prepare"]["input"] & {
      expected: SessionMessageRewriteSnapshot;
      message: unknown;
    };
    output: SessionMessageRewriteCommitted;
  };
  "session.transcript.manualCompact": {
    input: Target & { maxLines: number; nowMs?: number; sources?: SessionSourcePredicate[] };
    output: SessionTranscriptManualTrimResult;
  };
  "session.correction.commit": {
    input: Target & Omit<SessionTranscriptCorrectionInput, "scope" | "fence">;
    output: SessionTranscriptCorrectionCommitted;
  };
  "session.workerTranscript.commit": {
    input: Target & {
      receipt: WorkerTranscriptCommitInput;
      batch: Omit<TranscriptCommitInput, "scope">;
      preparedMessages: readonly CommittedAgentMessage[];
    };
    output: {
      result: ApplyTranscriptCommitResult;
      outcome: WorkerTranscriptCommitOutcome;
      replayed: boolean;
    };
  };
};
type Operations = SessionActorMemoryReportsReads & SessionActorMemoryReportsWrites;
export type SessionActorMemoryReportsCommand = {
  [Key in keyof Operations]: { type: Key; input: Operations[Key]["input"] };
}[keyof Operations];
