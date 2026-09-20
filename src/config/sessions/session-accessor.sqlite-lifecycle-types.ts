import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { ConversationRouteContext } from "./conversation-route-context.js";
import type {
  SessionLifecycleArchivedTranscript,
  SessionResetBoundaryWrite,
} from "./session-accessor.lifecycle-types.js";
import type {
  MaterializedSessionStateDeletePlan,
  SessionStateDeletePlan,
} from "./session-accessor.sqlite-archive-types.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
  SessionEntryLifecycleRemoval,
} from "./session-accessor.sqlite-contract.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import type { SessionEntryMaintenanceAgeFact } from "./session-accessor.sqlite-maintenance-age.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { InternalSessionEntry as SessionEntry } from "./types.js";

// Shared plan shapes only. Runtime ownership stays in maintenance and lifecycle-state.

export type ReclamationDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
};

export type SqliteSessionReclamationCallbacks = {
  beforeMutation?: () => void;
  onCommit?: (database: OpenClawAgentDatabase, result?: SqliteSessionReclamationResult) => void;
};

export type ReclamationDeleteParams = Omit<DeleteSessionEntryLifecycleParams, "commitGuard">;

/** Internal scope: a historical request cannot authorize whole-entry reclamation. */
export type SqliteSessionDeletionScope =
  | { kind: "entry"; phase: "plan" | "commit" }
  | { kind: "historical-generation"; phase: "plan" | "commit"; sessionId: string };
export type SessionEntryMaintenanceInput = {
  ageFact?: SessionEntryMaintenanceAgeFact;
  activeSessionKey?: string;
  activeSessionKeys?: readonly string[];
  archiveDirectory: string;
  forceMaintenance?: boolean;
  maintenance: ResolvedSessionMaintenanceConfig;
  preservation: SessionMaintenancePreservationSnapshot | null;
  storePath: string;
};

type SessionReclamationPlanBase = {
  databaseOptions: ReclamationDatabaseOptions;
  materializedPlans: MaterializedSessionStateDeletePlan[];
};

export type SqliteSessionReclamationPlan =
  | (SessionReclamationPlanBase & { kind: "maintenance-statistics" })
  | (SessionReclamationPlanBase & {
      kind: "maintenance-plan";
      input: SessionEntryMaintenanceInput;
    })
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

export type SqliteSessionReclamationResult =
  | { kind: "maintenance-statistics"; value: true }
  | { kind: "maintenance-preservation-required" }
  | {
      kind: "maintenance-plan";
      value: SessionEntryMaintenancePlan;
      ageFact?: SessionEntryMaintenanceAgeFact;
    }
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
  archivedSessionKeys: string[];
  archivedWorktrees?: Array<{ entry: SessionEntry; sessionKey: string; storePath: string }>;
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
export type ProjectedLifecycleMutation = {
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
