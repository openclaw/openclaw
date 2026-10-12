import type {
  SessionTranscriptCorpusArtifact,
  SessionTranscriptCorpusOptions,
  SessionTranscriptCorpusScope,
  SessionTranscriptCorpusEntry,
} from "../../../packages/memory-host-sdk/src/host/session-transcript-corpus.types.js";
import type { TranscriptArchivePresenceRead } from "./session-accessor.sqlite-archive-types.js";
import type {
  SessionTranscriptInstance,
  SessionTranscriptInstanceListOptions,
  SessionTranscriptStats,
} from "./session-accessor.sqlite-contract.js";
import type { SessionAccessScope, SessionEntryListScope } from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "./session-memory-targets.types.js";

export type SessionArchiveInventoryScope = Pick<
  SessionAccessScope,
  "agentId" | "env" | "storePath"
> & {
  archiveNames?: readonly string[];
  sessionIds?: readonly string[];
  includeAllAgents?: boolean;
};

type SessionArchiveInventoryEntry = {
  archiveName: string;
  sessionId: string;
  sessionKey: string;
  createdAt: number;
  agentId: string;
};

type SessionArchiveInventoryWorkerInput = SessionArchiveInventoryScope & {
  kind: "session-archive-inventory";
  database: { agentId: string; path: string };
};

type SessionCorpusInventoryWorkerInput = {
  kind: "session-corpus-inventory";
  database: { agentId: string; path: string };
  scope: SessionTranscriptCorpusScope;
  options: SessionTranscriptCorpusOptions;
  artifacts: readonly SessionTranscriptCorpusArtifact[];
  continuation?: CanonicalSessionReaderContinuation;
};

type MemorySessionTargetsWorkerInput = {
  kind: "memory-session-targets";
  database: { agentId: string; path: string };
  params: MemorySessionSelectors & { env: NodeJS.ProcessEnv };
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionTranscriptInstancesWorkerInput = {
  kind: "session-transcript-instances";
  database: { agentId: string; path: string };
  scope: Omit<SessionEntryListScope, "sessionKeys">;
  options: SessionTranscriptInstanceListOptions;
  continuation?: CanonicalSessionReaderContinuation;
};

type SessionTranscriptStatsBatchWorkerInput = {
  kind: "transcript-stats-batch";
  database: { agentId: string; path: string };
  sessionIds: readonly string[];
  env: NodeJS.ProcessEnv;
};

type SessionArchivePresenceWorkerInput = TranscriptArchivePresenceRead & {
  kind: "session-archive-presence";
};

export type SessionColdMetadataWorkerInput = {
  kind: "cold-metadata";
  database: { agentId: string; path: string };
  sessionId: string;
  env: NodeJS.ProcessEnv;
};

export type SessionColdMetadataWorkerResult = {
  kind: "cold-metadata";
  archive: Omit<SessionColdArchive, "archive_blob"> | undefined;
};

export type SessionColdStorageInventoryWorkerInput = {
  kind: "cold-storage-inventory";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
};

export type SessionTranscriptInventoryWorkerInput =
  | SessionTranscriptStatsBatchWorkerInput
  | SessionTranscriptInstancesWorkerInput
  | MemorySessionTargetsWorkerInput
  | SessionArchiveInventoryWorkerInput
  | SessionCorpusInventoryWorkerInput
  | SessionArchivePresenceWorkerInput;
export type SessionTranscriptInventoryWorkerValues = {
  "transcript-stats-batch": {
    kind: "transcript-stats-batch";
    stats: Array<SessionTranscriptStats | null>;
  };
  "session-transcript-instances": {
    kind: "session-transcript-instances";
    instances: SessionTranscriptInstance[];
  };
  "memory-session-targets": { kind: "memory-session-targets"; targets: MemorySessionTarget[] };
  "session-archive-inventory": {
    kind: "session-archive-inventory";
    archives: SessionArchiveInventoryEntry[];
  };
  "session-corpus-inventory": {
    kind: "session-corpus-inventory";
    entries: SessionTranscriptCorpusEntry[];
  };
  "session-archive-presence": { kind: "session-archive-presence"; registered: boolean };
};
export type SessionTranscriptInventoryReaders = {
  readTranscriptStatsBatch: (
    input: Omit<SessionTranscriptStatsBatchWorkerInput, "kind" | "database">,
  ) => Promise<Array<SessionTranscriptStats | null>>;
  readTranscriptInstances: (
    input: Omit<SessionTranscriptInstancesWorkerInput, "kind" | "database">,
  ) => Promise<SessionTranscriptInstance[]>;
  readMemorySessionTargets: (
    input: Omit<MemorySessionTargetsWorkerInput, "kind" | "database">,
  ) => Promise<MemorySessionTarget[]>;
  readArchiveInventory: (
    input: Omit<SessionArchiveInventoryWorkerInput, "kind" | "database">,
  ) => Promise<SessionArchiveInventoryEntry[]>;
  readCorpusInventory: (
    input: Omit<SessionCorpusInventoryWorkerInput, "kind" | "database">,
  ) => Promise<SessionTranscriptCorpusEntry[]>;
  readArchivePresence: (
    input: Omit<SessionArchivePresenceWorkerInput, "kind" | "database">,
  ) => Promise<boolean>;
};
