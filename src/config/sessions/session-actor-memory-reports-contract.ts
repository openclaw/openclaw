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
import type {
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
  "session.report.append": {
    input: Target & {
      version: SessionTranscriptContextVersion;
      report: TranscriptReportWorkerOperations["append"]["input"];
    };
    output: TranscriptReportWorkerOperations["append"]["output"];
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
