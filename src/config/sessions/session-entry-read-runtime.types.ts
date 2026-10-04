import type {
  SessionExactEntriesWorkerResult,
  SessionExactEntriesWorkerSelection,
} from "./session-transcript-worker.types.js";

export type SessionStoreWorkerReadScope = {
  agentId: string;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};

export type SessionEntryWorkerRead = SessionStoreWorkerReadScope &
  SessionExactEntriesWorkerSelection & {
    lifecycleSessionKey?: string;
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
