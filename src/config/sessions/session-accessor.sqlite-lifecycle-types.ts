import type {
  SubagentMaintenanceDurableBasis,
  SubagentRunsDurableBasis,
} from "../../agents/subagents/registry/subagent-registry-read.types.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal.js";
import type {
  DatabaseFileIdentity,
  DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import type {
  SessionArchivedTranscriptCleanupRule,
  SessionLifecycleArchivedTranscript,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
} from "./session-accessor.sqlite-archive-types.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  SessionEntryLifecycleRemoval,
  SessionEntryLifecycleUpsert,
  SqliteSessionArtifactPreparationDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type { SqliteSessionEntryRevision } from "./session-accessor.sqlite-entry-revision.js";
import type { SessionEntryMaintenanceAgeChange } from "./session-accessor.sqlite-maintenance-age.js";
import type {
  SessionEntryCommitContext,
  SessionEntryCreateWithTranscriptOptions,
} from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

/** Transportable planning facts; live guards and native identity remain with their owners. */
type SessionDeletionPlanningParams = Omit<
  DeleteSessionEntryLifecycleParams,
  "commitGuard" | "env" | "expectedDatabaseIdentity" | "descendantRunBasis"
>;

export type SessionEntryDeletionPlanInput = {
  deleteParams: SessionDeletionPlanningParams;
  archiveDirectory: string;
  admissionIdentities: readonly string[];
  allowLockedEntryRemoval: boolean;
  expectedPluginOwnerId?: string;
};
export type SessionEntryDeletionPlanResult =
  | { kind: "missing" }
  | { kind: "expected-entry-mismatch" }
  | {
      kind: "ready";
      value: {
        archiveDirectory: string;
        current: SqliteLifecycleTargetSnapshot[number];
        entryPlans: SessionStateDeletePlan[];
        historicalGenerationIds: string[];
        targetSnapshot: SqliteLifecycleTargetSnapshot;
      };
    };

type SessionDeletionPlanningValidation = {
  deleteParams: SessionDeletionPlanningParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  scope?: SqliteSessionDeletionScope;
};
export type SessionHistoricalDeletionCheckInput = {
  validation: SessionDeletionPlanningValidation;
  sessionId: string;
  admissionIdentities: readonly string[];
};
export type SessionHistoricalDeletionPlanInput = SessionHistoricalDeletionCheckInput & {
  archiveDirectory: string;
  archiveTranscript: boolean;
};
export type SessionHistoricalDeletionPlanResult =
  | { kind: "expected-entry-mismatch" }
  | { kind: "skip" }
  | { kind: "ready"; plan: SessionStateDeletePlan };
export type SessionHistoricalDeletionCheckResult =
  | { kind: "expected-entry-mismatch" }
  | { kind: "ready"; protectedSessionIds: string[] };

export type SessionDeletionPlanningOperation =
  | { operation: "entry"; input: SessionEntryDeletionPlanInput }
  | { operation: "history"; input: SessionHistoricalDeletionPlanInput }
  | { operation: "check"; input: SessionHistoricalDeletionCheckInput };

export type SessionDeletionPlanningResult =
  | { operation: "entry"; value: SessionEntryDeletionPlanResult }
  | { operation: "history"; value: SessionHistoricalDeletionPlanResult }
  | { operation: "check"; value: SessionHistoricalDeletionCheckResult };

export type SessionDeletionValidation = {
  deleteParams: DeleteSessionEntryLifecycleParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  scope?: SqliteSessionDeletionScope;
};

export type LifecycleRemovalProjectionInput = {
  allowCanonicalRepair?: boolean;
  archiveDirectory: string;
  removals: readonly SessionEntryLifecycleRemoval[];
};

export type ProjectedLifecycleCommitResult = {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
  beforeCount: number;
  maintenancePlans: SessionEntryMaintenancePlan[];
  removedSessionKeys: string[];
  pendingArchives: boolean;
  progressCardResetKeys?: string[];
  projectionReconcileSessionIds?: string[];
};

export type ProjectedLifecycleCommitInput = {
  projected: ProjectedLifecycleMutation;
  materializationFailed: boolean;
  allowCanonicalRepair?: boolean;
  maintenance: SessionEntryMaintenanceInput | null;
};

export type SessionEntryLifecycleMutationParams = {
  /** Internal durable comparison paired with the caller's live descendant guard. */
  descendantRunBasis?: SubagentRunsDurableBasis;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  storePath: string;
  removals?: Iterable<SessionEntryLifecycleRemoval>;
  upserts?: Iterable<SessionEntryLifecycleUpsert>;
  activeSessionKey?: string;
  maintenanceOverride?: Partial<ResolvedSessionMaintenanceConfig>;
  skipMaintenance?: boolean;
  cleanupArchivedTranscripts?: {
    rules: SessionArchivedTranscriptCleanupRule[];
    nowMs?: number;
  };
  captureArtifactCleanupError?: boolean;
  /** Doctor-only bypass while exact malformed rows are removed in the same transaction. */
  allowCanonicalRepair?: boolean;
  /** Doctor-only synchronous state transfer that commits with the destination entry. */
  afterUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  /** Fresh-row sidecar writes that must not retry unrelated pending archives. */
  afterFreshUpsertsInTransaction?: (database: OpenClawAgentDatabase) => void;
  /**
   * Revalidate caller and external lifecycle owners at each synchronous deletion boundary.
   * Must not write the deleting agent database: its Worker may hold the transaction lock.
   */
  commitGuard?: () => void;
  /** Synchronous caller-authority guard checked immediately before lifecycle writes. */
  beforeCommitInTransaction?: () => void;
  /** Retain source authority around the final writer, after projection and native preparation. */
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"];
  /** Non-throwing notification after outer COMMIT, before lifecycle publication and owner cleanup. */
  onLifecycleCommitted?: () => void;
  afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
};

export type ReclamationDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
};

export type SqliteSessionReclamationCallbacks = {
  beforeMutation?: () => void;
  onCommit?: (database: OpenClawAgentDatabase, result?: SqliteSessionReclamationResult) => void;
  afterCommit?: () => void;
};

export type ReclamationDeleteParams = Omit<
  DeleteSessionEntryLifecycleParams,
  "commitGuard" | "env" | "descendantRunBasis"
>;

/** Internal scope: a historical request cannot authorize whole-entry reclamation. */
export type SqliteSessionDeletionScope =
  | { kind: "entry"; phase: "plan" | "commit" }
  | { kind: "historical-generation"; phase: "plan" | "commit"; sessionId: string };
export type SessionEntryMaintenanceInput = {
  activeSessionKey?: string;
  activeSessionKeys?: readonly string[];
  archiveDirectory: string;
  forceMaintenance?: boolean;
  maintenance: ResolvedSessionMaintenanceConfig;
  preservation: SessionMaintenancePreservationSnapshot | null;
  storePath: string;
};

type SessionMaintenanceAgeSnapshot = {
  incarnation: string;
  revision: SqliteSessionEntryRevision;
  capture: number;
};

export type SessionMaintenanceLiveProtection = Pick<
  SessionEntryMaintenanceInput,
  "activeSessionKeys" | "preservation"
>;

type SessionReclamationPlanBase = {
  descendantRunBasis?: SubagentRunsDurableBasis;
  maintenanceRunBasis?: SubagentMaintenanceDurableBasis;
  databaseOptions: ReclamationDatabaseOptions;
  materializedPlans: MaterializedSessionStateDeletePlan[];
};

export type SessionMaintenanceMetadataCommand =
  | { kind: "maintenance-statistics" }
  | {
      kind: "maintenance-age";
      ageChanges?: readonly SessionEntryMaintenanceAgeChange[];
      maintenance: ResolvedSessionMaintenanceConfig;
      expected?: SessionMaintenanceAgeSnapshot;
      /** A no-op reader rechecks the same policy instead of borrowing a writer snapshot. */
      readOnly?: { input: SessionEntryMaintenanceInput; snapshot: SessionMaintenanceAgeSnapshot };
    }
  | {
      kind: "maintenance-plan";
      ageOwner?: string;
      ageChanges?: readonly SessionEntryMaintenanceAgeChange[];
      input: SessionEntryMaintenanceInput;
    };

export type SessionMaintenanceMetadataResult =
  | { kind: "maintenance-statistics"; value: true }
  | { kind: "maintenance-age"; nextAt: number | undefined }
  | { kind: "maintenance-preservation-required" }
  | { kind: "maintenance-plan-stale" }
  | {
      kind: "maintenance-plan";
      value: SessionEntryMaintenancePlan;
      ageSnapshot: SessionMaintenanceAgeSnapshot;
      readOnlyInput?: SessionEntryMaintenanceInput;
    };

export type SessionMaintenanceReadCommand = Exclude<
  SessionMaintenanceMetadataCommand,
  { kind: "maintenance-statistics" }
> & { expectedIdentity: DatabasePathIdentity };

export type SessionMaintenanceReadResult =
  | { kind: "maintenance-write-required" }
  | Exclude<SessionMaintenanceMetadataResult, { kind: "maintenance-statistics" }>;

export type SqliteSessionReclamationPlan =
  | (SessionReclamationPlanBase & {
      kind: "lifecycle-projection-plan";
      input: LifecycleRemovalProjectionInput;
    })
  | (SessionReclamationPlanBase & {
      agentId: string;
      kind: "lifecycle-projection-commit";
      input: ProjectedLifecycleCommitInput;
    })
  | (SessionReclamationPlanBase & {
      kind: "deletion-plan";
      planning: SessionDeletionPlanningOperation;
    })
  | (SessionReclamationPlanBase & {
      kind: "archive-publish-prepare";
      archiveDirectory: string;
      requested: readonly Pick<TranscriptArchivePublishPlan, "sessionId" | "generation">[];
    })
  | (SessionReclamationPlanBase & {
      kind: "archive-publish-record";
      results: readonly TranscriptArchivePublishResult[];
      nowMs: number;
    })
  | (SessionReclamationPlanBase & { kind: "maintenance-pages"; maxPages?: number })
  | (SessionReclamationPlanBase & SessionMaintenanceMetadataCommand & { materializedPlans: [] })
  | (SessionReclamationPlanBase & {
      agentId: string;
      entries: SessionEntryRemovalPlan[];
      kind: "maintenance-finalize";
    })
  | (SessionReclamationPlanBase & {
      deleteParams: ReclamationDeleteParams;
      kind: "entry";
      preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
    })
  | (SessionReclamationPlanBase & {
      agentId: string;
      entries: SessionEntryRemovalPlan[];
      kind: "lifecycle-artifacts";
    })
  | (SessionReclamationPlanBase & {
      diskBudget: { preserveRecentMs?: number | null };
      kind: "history-eviction";
      protectedSessionIds: string[];
      sessionId: string;
    })
  | (SessionReclamationPlanBase & {
      deleteParams: ReclamationDeleteParams;
      kind: "historical-generation";
      preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
      protectedSessionIds: string[];
      sessionId: string;
    });

export type SqliteArchiveReclamationPlan = Exclude<
  SqliteSessionReclamationPlan,
  SessionMaintenanceMetadataCommand
>;

export type SqliteSessionReclamationResult =
  | { kind: "lifecycle-projection-plan"; value: ProjectedLifecycleMutation }
  | { kind: "lifecycle-projection-commit"; value: ProjectedLifecycleCommitResult }
  | { kind: "deletion-plan"; value: SessionDeletionPlanningResult }
  | { kind: "archive-publish-prepare"; value: TranscriptArchivePublishPlan[] }
  | { kind: "archive-publish-record"; value: true }
  | { kind: "maintenance-pages"; value: SqliteWalReclamationResult }
  | SessionMaintenanceMetadataResult
  | {
      kind: "maintenance-finalize";
      value: {
        archivedTranscripts: SessionLifecycleArchivedTranscript[];
        changedEntries: SessionEntryRemovalPlan[];
        committedEntries: SessionEntryRemovalPlan[];
      };
    }
  | { kind: "entry"; value: DeleteSessionEntryLifecycleResult }
  | {
      kind: "lifecycle-artifacts";
      value: {
        archivedTranscripts: SessionLifecycleArchivedTranscript[];
        removedEntries: number;
      };
    }
  | {
      kind: "history-eviction";
      value: { archivedTranscripts: SessionLifecycleArchivedTranscript[]; deleted: boolean };
    }
  | {
      kind: "historical-generation";
      value: {
        archivedTranscripts: SessionLifecycleArchivedTranscript[];
        deleted: boolean;
        expectedEntryMismatch?: true;
      };
    };

export type SessionEntryRemovalPlan = {
  expectedEntry: SessionEntry | undefined;
  maintenanceReason?: "capped" | "model-run-pruned" | "pruned";
  sessionKey: string;
};
type SessionEntryMaintenanceCounts = {
  archived: number;
  capArchived: number;
  modelRunPruned: number;
  pruned: number;
  capped: number;
};
export type SessionEntryMaintenancePlan = SessionEntryMaintenanceCounts & {
  /** Exact rows written by planning; parent publication must not rescan the store. */
  archivedEntries: Array<{ sessionKey: string; sessionId?: string }>;
  entryRemovals: SessionEntryRemovalPlan[];
  stateDeletePlans: SessionStateDeletePlan[];
};
export type SessionEntryMaintenanceResult = SessionEntryMaintenanceCounts & {
  archivedTranscripts: SessionLifecycleArchivedTranscript[];
};
export type LifecycleArtifactCleanupPlan = {
  deletePlans: SessionStateDeletePlan[];
  entries: SessionEntryRemovalPlan[];
};
export type LifecycleArtifactCleanupInput = {
  continuation?: CanonicalSessionReaderContinuation;
  agentId?: string;
  archiveRemovedEntryTranscripts: boolean;
  archiveDirectory: string;
  pluginOwnerId?: string;
  sessionKeySegmentPrefix: string;
  transcriptContentMarker: string;
  orphanTranscriptMinAgeMs: number;
  nowMs: number;
  diagnostics?: SqliteSessionArtifactPreparationDiagnostics;
};
export type LifecycleArtifactCleanupRequest = {
  kind: "lifecycle-artifact-plan";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  input: LifecycleArtifactCleanupInput;
  expectedSource: DatabaseFileIdentity;
};
export type LifecycleArtifactCleanupWorkerResult = {
  kind: "lifecycle-artifact-plan";
  plan: LifecycleArtifactCleanupPlan;
  diagnostics: LifecycleArtifactCleanupInput["diagnostics"];
};
export type ProjectedLifecycleMutation = {
  archiveRecovery?: { pending: boolean; databaseIdentity: string };
  deletePlans: SessionStateDeletePlan[];
  removals: Array<{
    archiveTranscript: boolean;
    expectedEntry: SessionEntry;
    removal: SessionEntryLifecycleRemoval;
    sessionKey: string;
  }>;
  upsertedEntries: Array<{
    entry: SessionEntry;
    expectedEntry: SessionEntry | undefined;
    routeContext?: ConversationRouteContext | null;
    resetBoundary?: SessionResetBoundaryWrite;
    sessionKey: string;
  }>;
};
