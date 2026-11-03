import type { Selectable } from "kysely";
import type { PreparedSessionHistoryReadTarget } from "../../gateway/session-history-read.types.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.lifecycle-types.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import type { TranscriptEvent } from "./session-accessor.types.js";
import type { SessionArchivePruningRead } from "./session-history-archive-pruning.types.js";

export type SessionColdArchive = Selectable<DB["session_transcript_cold_archives"]>;
type SessionColdChunk = Selectable<DB["session_transcript_cold_archive_chunks"]>;
export type SessionColdChunkMetadata = Omit<SessionColdChunk, "archive_blob">;

export type SessionColdPlan = {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};
export type SessionColdPrepared = {
  plan: SessionColdPlan;
  archive: SessionColdArchive;
  chunks: SessionColdChunkMetadata[];
  envelopeBytes: number;
};
export type SessionColdExternalization = {
  chunks: SessionColdChunkMetadata[];
  archive: Omit<SessionColdArchive, "archive_blob">;
  envelopeBytes: number;
};
type SessionColdOversized = {
  sessionId: string;
  lowerBoundBytes: number;
};
export type SessionColdBatchInput = {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  admissionIdentities: string[];
  liveSessionKeys: string[];
  cooledSessionIds: string[];
  beforeMs: number;
  maxTranscripts: number;
  maxBytes: number;
};
export type SessionColdBatchPrepared = {
  freePages: number;
  protectionKeys: string[];
  prepared: SessionColdPrepared[];
  externalizations: SessionColdExternalization[];
  oversizedTranscripts: SessionColdOversized[];
  envelopeBytes: number;
};

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

export type SessionHistoryEvictionArchivePlan = Omit<SessionStateDeletePlan, "snapshot"> & {
  historyEviction: {
    expectedIdentity: DatabasePathIdentity;
    preserveRecentMs?: number | null;
  };
};

export type TranscriptArchiveWorkerPlan =
  | Pick<
      SessionStateDeletePlan,
      "agentId" | "archiveDirectory" | "databasePath" | "reason" | "sessionId" | "snapshot"
    >
  | SessionHistoryEvictionArchivePlan;

export type TranscriptArchiveWorkerResult = {
  archive: MaterializedSessionTranscriptArchive | null;
  sessionId: string;
  preparedPlan?: SessionStateDeletePlan | null;
};

export type TranscriptArchiveWorkerMessage = {
  type: "done";
  results: TranscriptArchiveWorkerResult[];
};

export type TranscriptArchivePublishPlan = {
  databaseIdentity?: string;
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
  expectedIdentity: DatabasePathIdentity | undefined;
};

export type TranscriptArchivePresenceRead = {
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  logicalAgentId: string;
  sessionId?: string;
  sessionKey: string;
  expectedIdentity: DatabasePathIdentity;
};

export type TranscriptArchiveReadResult = { event?: TranscriptEvent };

export type TranscriptArchivePageBinding = {
  sessionId: string;
  generation: string;
  sha256: string;
};

export type TranscriptArchivePageOptions = {
  runId: string;
  limit?: number;
  maxBytes?: number;
  cursor?: string;
  contextMaxMessages?: number;
  projectionSources?: Pick<PreparedSessionHistoryReadTarget, "stateDatabase" | "sourceDatabases">;
};

export type TranscriptArchivePagePlan = Omit<TranscriptArchiveReadPlan, "expectedIdentity"> &
  TranscriptArchivePageOptions & {
    limit: number;
    maxBytes: number;
    verifyBinding?: TranscriptArchivePageBinding;
  };

export type TranscriptArchivePageResult = {
  entries: Array<{ event: TranscriptEvent; seq: number; coordinationHidden?: true }>;
  contextEntries?: Array<{ event: TranscriptEvent; seq: number; coordinationHidden?: true }>;
  binding: TranscriptArchivePageBinding;
  nextCursor?: string;
  omittedOversized?: true;
  totalMessages: number;
};

export type SqliteArchiveOperation =
  | { operation: "cold-prepare"; input: SessionColdBatchInput }
  | { operation: "materialize"; plans: readonly TranscriptArchiveWorkerPlan[] }
  | { operation: "publish"; plans: readonly TranscriptArchivePublishPlan[] }
  | { operation: "read-page"; plans: readonly TranscriptArchivePagePlan[] }
  | { operation: "read-final"; plans: readonly TranscriptArchiveReadPlan[] };

export type SqliteArchiveOneShotWorkerData = (
  | Extract<SqliteArchiveOperation, { operation: "materialize" | "publish" }>
  | { operation: "cold-embed-snapshot"; snapshotPath: string; sourceStorePath: string }
) & { type: "sqlite-transcript-archive-v2" };

export type SqliteArchiveSessionRequest = SqliteArchiveOperation & {
  type: "archive-operation";
};

export type SqliteArchiveSessionResponse =
  | { type: "cold-prepared"; results: SessionColdBatchPrepared[] }
  | TranscriptArchiveWorkerMessage
  | TranscriptArchivePublishWorkerMessage
  | { type: "page-read"; results: Array<TranscriptArchivePageResult | undefined> }
  | { type: "final-read"; results: TranscriptArchiveReadResult[] };
export type SessionTranscriptMaintenanceSizingInput = {
  agentId: string;
  path: string;
  env: NodeJS.ProcessEnv;
  sessionIds: readonly string[];
};

export type SessionPendingArchivesWorkerInput = {
  kind: "session-pending-archives";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
};

export type SessionArchivePruningWorkerInput = SessionArchivePruningRead & {
  kind: "session-archive-pruning";
};
