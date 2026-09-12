import type {
  DeletedAgentSessionEntryPurgeParams,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
} from "./session-accessor.lifecycle-types.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

export type SessionEntryStatus = NonNullable<SessionEntry["status"]>;

/** Worker operation facts; no Worker object or plan payload is retained. */
export type SqliteSessionReclamationDiagnostics = {
  kind?:
    | "entry"
    | "lifecycle-artifacts"
    | "history-eviction"
    | "historical-generation"
    | "cold-batch"
    | "cold-maintain"
    | "cold-restore";
  workerThreadId?: number;
};

/** One validated request owns this record until its observed release event. */
export type SqliteSessionReclamationAdmissionDiagnostics = {
  admissionId: number;
  releaseCause?: "worker-release" | "worker-exit";
};

export type SqliteSessionDatabaseAdmissionDiagnostics = {
  admissionMode?: "cached" | "async";
  admissionMs?: number;
};

/** One cleanup attempt owns these numeric observations; no row or transcript is retained. */
export type SqliteSessionArtifactPreparationDiagnostics =
  SqliteSessionDatabaseAdmissionDiagnostics & {
    nodeInventoryMs?: number;
    referencePlanningMs?: number;
    orphanPlanningMs?: number;
    markerScanMs?: number;
    nodeRows?: number;
    windowRows?: number;
    referenceIds?: number;
    selectedEntries?: number;
    markerWindows?: number;
    markerRows?: number;
    deletePlans?: number;
    completed?: boolean;
  };

/** One pruning attempt retains only aggregate stage observations. */
export type SqliteSessionArchivePruningDiagnostics = {
  trigger: "initial" | "after-eviction" | "final";
  admissionMs?: number;
  cachedAdmissions?: number;
  asyncAdmissions?: number;
  checkpointCalls?: number;
  checkpointIncomplete?: number;
  checkpointMs?: number;
  checkpointMaxMs?: number;
  vacuumMs?: number;
  vacuumPasses?: number;
  vacuumPagesRequested?: number;
  queryMs?: number;
  rowDeletionMs?: number;
  fileRemovalMs?: number;
  removedFiles?: number;
  missingFiles?: number;
  failedRemovals?: number;
  measurementMs?: number;
  measurements?: number;
  legacyInventoryMs?: number;
  completed?: boolean;
};

export type SqliteSessionWriteDiagnostics = SqliteSessionReclamationDiagnostics & {
  artifactPreparation?: SqliteSessionArtifactPreparationDiagnostics;
  archivePruning?: SqliteSessionArchivePruningDiagnostics;
  reclamationAdmission?: SqliteSessionReclamationAdmissionDiagnostics;
};

export type SessionTranscriptInstance = SessionEntrySummary & {
  agentId: string;
  /** Stable transcript identity, including rotated history for one logical session key. */
  sessionId: string;
  /** True when this transcript instance was owned by an ACP runtime. */
  acpOwned: boolean;
  /** True when exclusion-sensitive session ownership was captured for this transcript id. */
  provenanceKnown: boolean;
  /** Activity timestamp for this transcript instance, not the current logical session row. */
  updatedAtMs: number;
  /** Recorded source facts; coarse historical trust classes cannot identify an exact hook source. */
  sourceMetadata: {
    createdAt: number;
    channel: string | null;
    accountId: string | null;
    chatType: NonNullable<SessionEntry["chatType"]> | null;
    hookExternalContentSource: NonNullable<SessionEntry["hookExternalContentSource"]> | null;
  };
};

export type SessionTranscriptInstanceListOptions = {
  /** Include empty and internal windows when inspecting recorded source metadata. */
  includeAllWindows?: boolean;
  sessionId?: string;
};

export type TranscriptEventAppendOptions = {
  appendIntent?: "active-branch";
  /** Synchronous authority check run inside the append transaction. */
  beforeCommitInTransaction?: () => void;
  /** Reject the append when the transcript changed since the caller loaded it. */
  expectedMutationAt?: number | null;
  /** Captures the parent selected by an active-branch event append. */
  captureEffectiveParentIdInTransaction?: (parentId: string | null) => void;
};

export type TranscriptAppendRefusal =
  | {
      actualSessionIdHash: string;
      agentIdHash: string;
      code: "session-rebound";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    }
  | {
      agentIdHash: string;
      code: "session-entry-missing";
      expectedSessionIdHash: string;
      sessionKeyHash: string;
    };

export type {
  ForkSessionEntryFromParentTargetParams,
  ForkSessionEntryFromParentTargetResult,
  ForkSessionFromParentTranscriptParams,
  ForkSessionFromParentTranscriptResult,
  SessionParentForkDecision,
  SessionTranscriptRawDeltaLimits,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptVisibleMessageDeltaLimits,
  SessionTranscriptVisibleMessageDeltaResult,
  TranscriptEvent,
} from "./session-accessor.types.js";

export type LatestTranscriptAssistantMessage = {
  id?: string;
  message: unknown;
};

type SessionEntryBatchProjectionMutation = {
  entry: SessionEntry;
  previousSessionKeys?: readonly string[];
  sessionKey: string;
};

export type SessionEntryBatchProjectionUpdate<T> = {
  mutations?: Iterable<SessionEntryBatchProjectionMutation>;
  result: T;
};

export type {
  DeletedAgentSessionEntryPurgeParams,
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  ResetSessionEntryLifecycleParams,
  ResetSessionEntryLifecycleResult,
  SessionEntryLifecycleMutationResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SessionLifecycleArchivedTranscript,
  SessionLifecycleArtifactCleanupParams,
  SessionLifecycleArtifactCleanupResult,
};

export type {
  ExactSessionEntry,
  LatestTranscriptAssistantText,
  SessionAccessScope,
  SessionEntryPatchContext,
  SessionEntryPatchOptions,
  SessionEntryReplacementSnapshot,
  SessionEntryReplacementUpdate,
  SessionEntrySummary,
  SessionEntryTargetPatchScope,
  SessionTranscriptAccessScope,
  SessionTranscriptEventRow,
  SessionTranscriptReadScope,
  SessionTranscriptStats,
  SessionTranscriptTurnMessageAppend,
  SessionTranscriptTurnWriteContext,
  SessionTranscriptWriteScope,
  TranscriptMessageAppendOptions,
  TranscriptMessageAppendResult,
  TranscriptUpdatePayload,
} from "./session-accessor.types.js";
