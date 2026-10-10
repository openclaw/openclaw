import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type {
  SessionExactEntriesWorkerResult,
  SessionExactEntriesWorkerSelection,
  SessionEntryCohortRequest,
  SessionEntryCohortResult,
} from "./session-entry-read.types.js";
import type { SessionEntrySnapshotField } from "./session-entry-snapshots.js";

export type SessionStoreWorkerReadScope = {
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
  /** Borrow physical selection from its live owner; rows still come from a fresh read. */
  preparedSource?: CapturedSessionEntryReadSource & {
    databaseIdentity: string;
    assertCurrent: () => void;
  };
};

export type SessionEntryWorkerRead = SessionStoreWorkerReadScope &
  SessionExactEntriesWorkerSelection & {
    lifecycleSessionKey?: string;
    snapshotFields?: readonly SessionEntrySnapshotField[];
    projection?: "full" | "sharing" | "list" | "exact" | "worktree";
    includeMembers?: boolean;
    includeParticipantRecords?: boolean;
    includeAuthorization?: boolean;
  };

export type SessionStoreWorkerReadInput = Omit<SessionStoreWorkerReadScope, "agentId"> & {
  agentId?: string;
  defaultAgentId?: string;
  projection?: SessionEntryWorkerRead["projection"] | SessionEntryReadScope["projection"];
};

export type PreparedSessionEntryWorkerRead = {
  result: SessionExactEntriesWorkerResult;
  database: { agentId: string; path: string; env: NodeJS.ProcessEnv };
  assertCurrent: () => void;
};

export type SessionEntryReadSourcePreparation = (
  database: PreparedSessionEntryWorkerRead["database"],
  identity: DatabasePathIdentity,
) => void;

/** One admitted physical owner; each call prepares a fresh synchronous consumption phase. */
export type SessionEntryCohortReader = {
  readonly database: PreparedSessionEntryWorkerRead["database"];
  readonly sessionKey: string;
  readonly logicalAgentId: string;
  readonly storePaths: readonly string[];
  assertCurrent(): void;
  withRead<T>(
    request: Omit<SessionEntryCohortRequest, "expected">,
    assertCallerCurrent: () => void,
    consume: (read: SessionEntryCohortResult, assertCurrent: () => void) => T,
  ): Promise<T>;
};
