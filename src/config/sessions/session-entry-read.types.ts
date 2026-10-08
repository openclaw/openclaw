import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import type { SessionParticipantRecord } from "./session-accessor.sqlite-participant-projection.js";
import type {
  SessionEntryReplacementSelection,
  SessionEntryReplacementState,
} from "./session-accessor.sqlite-replacement-read.js";
import type {
  SessionEntryListScope,
  SessionEntryReadScope,
  SessionEntrySummary,
  SessionTranscriptRuntimeScope,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import type { SessionEntrySnapshotField } from "./session-entry-snapshots.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type {
  SessionSourcePredicate,
  SessionSourcePredicateFacts,
} from "./session-source-authority.js";
import type { SessionTranscriptWorkerReadError } from "./session-transcript-worker-error.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryReadWorkerInput = {
  kind: "session-entry-read";
  database: { agentId: string; path: string };
  scope: SessionEntryReadScope & { databaseAgentId: string };
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionEntryReadWorkerResult = {
  kind: "session-entry-read";
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
} & (
  | { entry: SessionEntry | undefined; readError?: never }
  | { entry: undefined; readError: SessionTranscriptWorkerReadError }
);

export type SessionEntryListWorkerInput = {
  kind: "session-entry-list";
  database: { agentId: string; path: string };
  scope: SessionEntryListScope & { cleanupSession?: string };
  expectedIdentity?: DatabasePathIdentity;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionEntryListWorkerResult = {
  kind: "session-entry-list";
  entries: SessionEntrySummary[];
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
};

export type SessionExactEntriesWorkerInput = {
  kind: "session-exact-entries";
  database: { agentId: string; path: string };
} & SessionExactEntriesWorkerRequest;

export type SessionExactEntriesWorkerSelection =
  | {
      sessionKeys: readonly string[];
      selection?: never;
      projection?:
        | "full"
        | "sharing"
        | "replacement"
        | "creation"
        | "list"
        | "lifecycle"
        | "exact"
        | "worktree";
    }
  | {
      sessionKeys?: never;
      selection: { kind: "session-id"; sessionId: string };
      projection: "sharing";
    };

export type SessionExactEntriesWorkerRequest = SessionExactEntriesWorkerSelection & {
  manualCompact?: { sessionId: string; sources: SessionSourcePredicate[] };
  expectedIdentity?: SessionEntryListWorkerInput["expectedIdentity"];
  /** Omitted retains the complete entry; an empty selection reads metadata only. */
  snapshotFields?: readonly SessionEntrySnapshotField[];
  env: NodeJS.ProcessEnv;
  lifecycleSessionKey?: string;
  /** Reply initialization reads the current row's model parent in this same snapshot. */
  replyInitializationSessionKey?: string;
  includeMembers?: boolean;
  includeParticipantRecords?: boolean;
  includeAuthorization?: boolean;
  replacementSelection?: SessionEntryReplacementSelection;
  creationLabel?: string;
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionExactEntriesWorkerResult = {
  kind: "session-exact-entries";
  source?: SessionEntryListWorkerResult["source"];
  entries: SessionEntrySummary[];
  lifecycleTimestamps: SessionLifecycleTimestamps;
  manualCompact?: {
    archive?: Omit<SessionColdArchive, "archive_blob">;
    refusedSource?: { index: number; facts: SessionSourcePredicateFacts };
  };
  pendingArchives?: boolean;
  databaseIdentity?: {
    identity: string;
    incarnation: string;
    filename: string;
    birthtime?: string;
  };
  members?: Record<string, SessionMember[]>;
  participantRecords?: Record<string, SessionParticipantRecord[]>;
  replacement?: SessionEntryReplacementState & { databaseIdentity: string };
  creation?: import("./session-accessor.sqlite-creation-read.js").SessionCreationSnapshot & {
    databaseIdentity: string;
    databasePath: string;
  };
  sharing?: {
    source: { agentId: string; path: string };
    databaseIdentity: string;
    members: Array<{ sessionKey: string; identityIds: string[] }>;
    placeholders: Array<{ sessionKey: string; sessionId: string }>;
  };
};

export type SessionRuntimeTargetWorkerInput = {
  kind: "session-runtime-target";
  database: { agentId: string; path: string };
  scope: SessionTranscriptRuntimeScope & { agentId: string; storePath: string };
  keyFormat?: "agent-qualified";
  continuation?: CanonicalSessionReaderContinuation;
};

export type SessionRuntimeTargetWorkerResult = {
  kind: "session-runtime-target";
  source?: CapturedSessionEntryReadSource & { databaseIdentity: string };
  target: Awaited<
    ReturnType<
      typeof import("./session-accessor.transcript-target.js").resolveSessionTranscriptRuntimeTarget
    >
  >;
};
