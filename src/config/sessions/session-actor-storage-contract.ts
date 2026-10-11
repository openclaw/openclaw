import type { SessionGoalOperationErrorCode } from "./goals-operations.types.js";
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
import type { SessionActorAuthority, SessionActorHotState } from "./session-actor-state.types.js";
import type { PendingInputCustodyCandidate } from "./session-pending-input-history.types.js";

export type SessionActorStorageReads = SessionActorMemoryEntryReads &
  SessionActorMemoryForkReads &
  SessionActorMemoryHistoryReads &
  SessionActorMemoryMetadataReads &
  SessionActorMemoryPendingReads;
export type SessionActorStorageWrites = SessionActorMemoryEntryWrites &
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
      error: { name: string; message: string; code?: SessionGoalOperationErrorCode };
    };

export type SessionActorStorageAuthority = SessionActorAuthority & {
  /** The existing live pending-input owner decides whether reconciliation may interrupt custody. */
  isPendingInputProtected?(
    candidate: PendingInputCustodyCandidate,
    currentSessionId: string | undefined,
  ): boolean;
};

type SessionActorStorageCommitObserver<Value> = {
  committed(outcome: Extract<SessionActorStorageOutcome<Value>, { kind: "committed" }>): void;
};

/** Bound at acquisition; shares the actor's accepted work, FIFO, and state owner. */
export type SessionActorStorage = {
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
