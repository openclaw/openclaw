import type { OpenClawConfig } from "../types.openclaw.js";
import type {
  SessionTranscriptTurnMutation,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { CliHistoryWriterFacts } from "./session-accessor.sqlite-cli-history-boundary.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
} from "./session-accessor.sqlite-pending-inputs.js";
import type {
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnPersistOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { SessionEntry } from "./types.js";
export type SqliteExpectedSessionTranscriptTurnResult = {
  sessionTurnMutationResult?: SessionTranscriptTurnMutationResult;
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  predicateSkipped?: boolean;
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

export type SqliteSessionTurnOptions = {
  workerPrepared?: true;
  preparedGoalId?: string;
  assertCurrent?: () => void;
  acceptedResultGuard?: SessionTranscriptTurnPersistOptions["acceptedResultGuard"];
  atomicGroup?: boolean;
  keyFormat?: "agent-qualified";
  config?: OpenClawConfig;
  cwd?: string;
  expectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  expectedWriterRunId?: SessionTranscriptTurnExpectedState["expectedWriterRunId"];
  expectedSessionState?: SessionTranscriptTurnExpectedState;
  expectedSessionId: string;
  selectedSessionId?: string | null;
  selectedLifecycleRevision?: SessionLifecycleRevisionExpectation;
  initialSessionEntry?: SessionEntry;
  messages: readonly SessionTranscriptTurnMessageAppend[];
  onMessageCommitted?: SessionTranscriptTurnPersistOptions["onMessageCommitted"];
  onCommittedSource?: (source: CapturedSessionEntryReadSource, entry: SessionEntry) => void;
  sessionLifecyclePatch?: SessionTranscriptTurnLifecyclePatch;
  sessionTurnMutation?: SessionTranscriptTurnMutation;
  sessionFile: string;
  touchSessionEntry?: boolean;
};

export type SessionTurnPlan = {
  agentId: string;
  sessionKey: string;
  options: Omit<
    SqliteSessionTurnOptions,
    | "messages"
    | "onMessageCommitted"
    | "onCommittedSource"
    | "assertCurrent"
    | "sessionTurnMutation"
    | "config"
  > & {
    sessionTurnMutation?: Omit<SessionTranscriptTurnMutation, "assertCurrent">;
    messages: Array<
      Omit<
        SessionTranscriptTurnMessageAppend,
        | "config"
        | "shouldAppend"
        | "shouldAppendInTransaction"
        | "prepareMessageAfterIdempotencyCheck"
        | "beforeFreshMessageCommit"
        | "workerPreparation"
      > & {
        preparationVersion?: SessionTranscriptContextVersion;
        sources?: SessionSourcePredicate[];
        freshGuard?: true;
        preparation?: {
          prepared: boolean;
          expected: { messageId: string; message: unknown } | undefined;
          message: unknown;
        };
      }
    >;
  };
  custody?: SessionPendingInputWorkerFacts;
  relocation?: string;
  cliWriter?: CliHistoryWriterFacts;
};
export type SessionTurnCommitted = {
  kind: "session-turn";
  result: SqliteExpectedSessionTranscriptTurnResult;
  sequences: Array<number | undefined>;
  projectionNeedsReconcile: boolean;
  custody?: SessionPendingInputWorkerReceipt;
  authority?: import("./session-pending-input-authority.js").SessionPendingInputAuthorityFacts;
  publication?: SessionEntryReplacementPublication;
};
