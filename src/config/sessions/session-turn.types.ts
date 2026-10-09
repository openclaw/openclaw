import type {
  ClientVoiceRunBinding,
  ClientVoiceSessionRecord,
} from "../../talk/client-voice-session-store.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { CliHistoryWriterFacts } from "./cli-history-boundary.js";
import type {
  SessionTranscriptTurnMutation,
  SessionTranscriptTurnMutationResult,
} from "./goals-operations.types.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache.types.js";
import type {
  SessionPendingInputWorkerFacts,
  SessionPendingInputWorkerReceipt,
} from "./session-accessor.sqlite-pending-inputs.js";
import type {
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptWriteScope,
  SessionTranscriptTurnPersistOptions,
  TranscriptMessageAppendResult,
} from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type {
  PreparedSessionSourceAuthority,
  SessionSourcePredicate,
} from "./session-source-authority.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import type {
  SessionLifecycleRevisionExpectation,
  SessionTranscriptTurnExpectedState,
  SessionTranscriptTurnLifecyclePatch,
} from "./session-transcript-turn-lifecycle.types.js";
import type { SessionEntry } from "./types.js";
export type SqliteExpectedSessionTranscriptTurnResult = {
  voiceSession?: ClientVoiceSessionRecord;
  transcriptVersion?: SessionTranscriptContextVersion;
  sessionTurnMutationResult?: SessionTranscriptTurnMutationResult;
  appendedMessages: TranscriptMessageAppendResult<unknown>[];
  rejectedReason?: "session-rebound";
  predicateSkipped?: boolean;
  sessionEntry: SessionEntry | undefined;
  sessionFile: string;
};

export type SqliteSessionTurnOptions = {
  /** Same-store voice bookkeeping commits atomically with its reserved transcript event. */
  voiceTranscript?: ClientVoiceRunBinding & { failureKey: string; role: "user" | "assistant" };
  ownerSource?: PreparedSessionSourceAuthority;
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
  expectedOwner?: SessionTranscriptWriteScope["expectedOwner"];
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
  prepareColdTranscript?: true;
  options: Omit<
    SqliteSessionTurnOptions,
    | "messages"
    | "onMessageCommitted"
    | "onCommittedSource"
    | "assertCurrent"
    | "sessionTurnMutation"
    | "config"
    | "ownerSource"
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
        | "preparation"
      > & {
        preparationVersion?: SessionTranscriptContextVersion;
        sources?: SessionSourcePredicate[];
        freshGuard?: true;
        preparedMessage?: {
          prepared: boolean;
          expected: { messageId: string; message: unknown } | undefined;
          message: unknown;
        };
      }
    >;
  };
  ownerSources?: SessionSourcePredicate[];
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

export type IncognitoSessionTurnOperations = {
  "session.turn.prepare": {
    input: SessionTurnPlan;
    output: ReturnType<typeof import("./session-turn.worker.js").prepareSessionTurn>;
  };
  "session.turn.commit": { input: SessionTurnPlan; output: SessionTurnCommitted };
};
