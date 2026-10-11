import type { BoardValidationError } from "../../boards/board-layout.js";
import type {
  SessionActorBoardReads,
  SessionActorBoardWrites,
} from "../../boards/session-actor-board-contract.js";
import type {
  SessionActorProgressCardReads,
  SessionActorProgressCardWrites,
} from "../../session-cards/session-actor-progress-card-contract.js";
import type { SessionGoalOperationErrorCode } from "./goals-operations.types.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorHotState,
  SessionActorLifetime,
} from "./session-actor-contract.js";
import type {
  SessionActorMemoryCollaborationReads,
  SessionActorMemoryCollaborationWrites,
} from "./session-actor-memory-collaboration-contract.js";
import type { SessionActorMemoryCompletionReads } from "./session-actor-memory-completion-contract.js";
import type {
  SessionActorMemoryConversationReads,
  SessionActorMemoryConversationWrites,
} from "./session-actor-memory-conversation-contract.js";
import type { SessionActorMemoryCorpusReads } from "./session-actor-memory-corpus-contract.js";
import type {
  SessionActorMemoryEntryReads,
  SessionActorMemoryEntryWrites,
} from "./session-actor-memory-entry-contract.js";
import type {
  SessionActorMemoryForkReads,
  SessionActorMemoryForkWrites,
} from "./session-actor-memory-fork-contract.js";
import type { SessionActorMemoryHistoryReads } from "./session-actor-memory-history-contract.js";
import type {
  SessionActorMemoryMetadataReads,
  SessionActorMemoryMetadataWrites,
} from "./session-actor-memory-metadata-contract.js";
import type {
  SessionActorMemoryPendingReads,
  SessionActorMemoryPendingWrites,
} from "./session-actor-memory-pending-contract.js";
import type {
  SessionActorMemoryReportsReads,
  SessionActorMemoryReportsWrites,
} from "./session-actor-memory-reports-contract.js";
import type { SessionActorMemorySearchReads } from "./session-actor-memory-search-contract.js";
import type {
  SessionActorMemorySideEffectsReads,
  SessionActorMemorySideEffectsWrites,
} from "./session-actor-memory-side-effects-contract.js";
import type { SessionActorMemoryTurnReads } from "./session-actor-memory-turn-contract.js";
import type {
  SessionActorMemoryUsageReads,
  SessionActorMemoryUsageWrites,
} from "./session-actor-memory-usage-contract.js";
import type { PendingInputCustodyCandidate } from "./session-pending-input-history.types.js";
import type { TranscriptAppendRefusal } from "./session-transcript-writer-claim-error.js";

export type SessionActorStorageReads = SessionActorMemoryConversationReads &
  SessionActorMemoryCorpusReads &
  SessionActorMemoryTurnReads &
  SessionActorMemoryCollaborationReads &
  SessionActorMemorySideEffectsReads &
  SessionActorBoardReads &
  SessionActorProgressCardReads &
  SessionActorMemoryReportsReads &
  SessionActorMemoryUsageReads &
  SessionActorMemorySearchReads &
  SessionActorMemoryCompletionReads &
  SessionActorMemoryEntryReads &
  SessionActorMemoryForkReads &
  SessionActorMemoryHistoryReads &
  SessionActorMemoryMetadataReads &
  SessionActorMemoryPendingReads;
export type SessionActorStorageWrites = SessionActorMemoryConversationWrites &
  SessionActorMemoryCollaborationWrites &
  SessionActorMemorySideEffectsWrites &
  SessionActorBoardWrites &
  SessionActorProgressCardWrites &
  SessionActorMemoryReportsWrites &
  SessionActorMemoryUsageWrites &
  SessionActorMemoryEntryWrites &
  SessionActorMemoryForkWrites &
  SessionActorMemoryMetadataWrites &
  SessionActorMemoryPendingWrites;

export type SessionActorStorageQuery = {
  [Key in keyof SessionActorStorageReads]: {
    type: Key;
    input: SessionActorStorageReads[Key]["input"];
  };
}[keyof SessionActorStorageReads];
export type SessionActorStorageCommand = {
  [Key in keyof SessionActorStorageWrites]: {
    type: Key;
    input: SessionActorStorageWrites[Key]["input"];
  };
}[keyof SessionActorStorageWrites];

export type SessionActorStorageChange = {
  sessionKey: string;
  before: SessionActorHotState | undefined;
  after: SessionActorHotState | undefined;
};
export type SessionActorStorageOutcome<Value> =
  | {
      kind: "committed";
      value: Value;
      changes: SessionActorStorageChange[];
      failure?: { name: string; message: string };
    }
  | {
      kind: "rolled-back";
      error: {
        name: string;
        message: string;
        code?: SessionGoalOperationErrorCode | BoardValidationError["code"];
        sessionId?: string;
        operationLabel?: string;
        sessionKey?: string;
        refusal?: TranscriptAppendRefusal;
      };
    };

export type SessionActorStorageAuthority = SessionActorAuthority & {
  /** The existing live pending-input owner decides whether reconciliation may interrupt custody. */
  isPendingInputProtected?(
    candidate: PendingInputCustodyCandidate,
    currentSessionId: string | undefined,
  ): boolean;
};

export type SessionActorStorageCommitObserver<Value> = {
  committed(outcome: Extract<SessionActorStorageOutcome<Value>, { kind: "committed" }>): void;
};

/** Bound at acquisition; shares the actor's accepted work, FIFO, and state owner. */
export type SessionActorStorage = {
  /** Synchronous current facts for an actual effect; never reads an uninstalled working copy. */
  readCurrent<Key extends keyof SessionActorStorageReads>(
    query: { type: Key; input: SessionActorStorageReads[Key]["input"] },
    authority: SessionActorStorageAuthority,
  ): SessionActorStorageReads[Key]["output"];
  /** Acquire a separately releasable handle from this already-selected owner. */
  acquire(sessionKey: string, lifetime?: SessionActorLifetime): Promise<SessionActor>;

  read<Key extends keyof SessionActorStorageReads>(
    query: { type: Key; input: SessionActorStorageReads[Key]["input"] },
    authority: SessionActorStorageAuthority,
  ): Promise<SessionActorStorageReads[Key]["output"]>;
  mutate<Key extends keyof SessionActorStorageWrites>(
    command: { type: Key; input: SessionActorStorageWrites[Key]["input"] },
    authority: SessionActorStorageAuthority,
    observer?: SessionActorStorageCommitObserver<SessionActorStorageWrites[Key]["output"]>,
  ): Promise<SessionActorStorageOutcome<SessionActorStorageWrites[Key]["output"]>>;
};
