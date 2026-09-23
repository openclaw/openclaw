import type { SessionLifecycleArchivedTranscript } from "./session-accessor.lifecycle-types.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import type { TranscriptEvent } from "./session-accessor.types.js";

export type SessionStateDeletePlan = {
  agentId: string;
  archiveDirectory: string;
  archiveTranscript: boolean;
  databasePath: string;
  reason: "deleted" | "reset";
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};

export type MaterializedSessionStateDeletePlan = SessionStateDeletePlan & {
  archive: MaterializedSessionTranscriptArchive | null;
  archivedTranscript: SessionLifecycleArchivedTranscript | null;
};

type MaterializedSessionTranscriptArchive = {
  archiveName: string;
  bytes: Uint8Array;
  createdAt: number;
  encoding: "identity" | "zstd";
  sha256: string;
};

export type TranscriptArchiveWorkerPlan = Pick<
  SessionStateDeletePlan,
  "agentId" | "archiveDirectory" | "databasePath" | "reason" | "sessionId" | "snapshot"
>;

export type TranscriptArchiveWorkerResult = {
  archive: MaterializedSessionTranscriptArchive | null;
  sessionId: string;
};

export type TranscriptArchiveWorkerMessage = {
  type: "done";
  results: TranscriptArchiveWorkerResult[];
};

export type TranscriptArchivePublishPlan = {
  agentId: string;
  archiveDirectory: string;
  databasePath: string;
  generation: string;
  sessionId: string;
};

export type TranscriptArchivePublishResult = {
  archivedPath?: string;
  error?: string;
  generation: string;
  sessionId: string;
};

export type TranscriptArchivePublishWorkerMessage = {
  type: "published";
  results: TranscriptArchivePublishResult[];
};

export type TranscriptArchiveReadPlan = {
  agentId: string;
  databasePath: string;
  logicalAgentId: string;
  sessionId?: string;
  sessionKey: string;
  runId: string;
};

export type TranscriptArchiveReadResult = { event?: TranscriptEvent };

export type SqliteArchiveOperation =
  | { operation: "materialize"; plans: readonly TranscriptArchiveWorkerPlan[] }
  | { operation: "publish"; plans: readonly TranscriptArchivePublishPlan[] }
  | { operation: "read-final"; plans: readonly TranscriptArchiveReadPlan[] };

export type SqliteArchiveSessionRequest = SqliteArchiveOperation & {
  type: "archive-operation";
  operationId: number;
};

export type SqliteArchiveSessionResponse = {
  operationId: number;
  settled: true;
} & (
  | { type: "done"; results: TranscriptArchiveWorkerResult[] }
  | { type: "published"; results: TranscriptArchivePublishResult[] }
  | { type: "final-read"; results: TranscriptArchiveReadResult[] }
);
export type SessionTranscriptMaintenanceSizingInput = {
  agentId: string;
  path: string;
  env: NodeJS.ProcessEnv;
  sessionIds: readonly string[];
};
