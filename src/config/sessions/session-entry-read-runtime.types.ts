import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type {
  SessionExactEntriesWorkerResult,
  SessionExactEntriesWorkerSelection,
} from "./session-entry-read.types.js";
import type { SessionEntrySnapshotField } from "./session-entry-snapshots.js";

export type SessionStoreWorkerReadScope = {
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

export type SessionEntryWorkerRead = SessionStoreWorkerReadScope &
  SessionExactEntriesWorkerSelection & {
    lifecycleSessionKey?: string;
    snapshotFields?: readonly SessionEntrySnapshotField[];
    projection?: "full" | "sharing" | "list" | "exact";
    includeMembers?: boolean;
    includeParticipantRecords?: boolean;
    includeAuthorization?: boolean;
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
