import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import {
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  partitionUnchangedPlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ReclamationDatabaseOptions,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceMetadataResult,
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  readSessionEntryMaintenanceAgeFact,
  stageSessionEntryMaintenanceAgeFact,
} from "./session-accessor.sqlite-maintenance-age.js";
import {
  applySessionEntryMaintenanceInDatabase,
  refreshSessionPlannerStatisticsInDatabase,
} from "./session-accessor.sqlite-maintenance-store.js";

type MaintenancePlan = Extract<
  SqliteSessionReclamationPlan,
  {
    kind: "maintenance-plan" | "maintenance-finalize" | "maintenance-statistics";
  }
>;

export function reclaimSessionMaintenanceInTransaction(
  plan: MaintenancePlan,
  callbacks: SqliteSessionReclamationCallbacks,
): SqliteSessionReclamationResult {
  if (plan.kind !== "maintenance-finalize") {
    return runSessionMaintenanceMetadataInTransaction(plan, callbacks);
  }
  return runSqliteSessionDeletionTransaction((database) => {
    callbacks.beforeMutation?.();
    const partition = partitionUnchangedPlannedLifecycleArtifactEntries(database, plan.entries);
    const archivedTranscripts = deleteMaterializedSessionStatePlans(
      database,
      plan.materializedPlans,
      undefined,
      new Set(partition.unchanged.map((entry) => entry.sessionKey)),
    );
    deletePlannedLifecycleArtifactEntries(database, partition.unchanged);
    const result: Extract<SqliteSessionReclamationResult, { kind: "maintenance-finalize" }> = {
      kind: plan.kind,
      value: {
        archivedTranscripts,
        changedEntries: partition.changed,
        committedEntries: partition.unchanged,
      },
    };
    callbacks.onCommit?.(database, result);
    return result;
  }, plan.databaseOptions);
}

export function runSessionMaintenanceMetadataInTransaction(
  plan: SessionMaintenanceMetadataCommand & { databaseOptions: ReclamationDatabaseOptions },
  callbacks: {
    beforeMutation?: (database: OpenClawAgentDatabase) => void;
    onCommit?: SqliteSessionReclamationCallbacks["onCommit"];
    beforeCommit?: (database: OpenClawAgentDatabase) => void;
    onArchived?: Parameters<typeof applySessionEntryMaintenanceInDatabase>[3];
  },
): SessionMaintenanceMetadataResult {
  if (plan.kind === "maintenance-statistics") {
    const database = openOpenClawAgentDatabase(plan.databaseOptions);
    runWithSqliteBusyTimeout(database.db, 0, () =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          callbacks.beforeMutation?.(current);
          refreshSessionPlannerStatisticsInDatabase(current);
          callbacks.onCommit?.(current);
          callbacks.beforeCommit?.(current);
        },
        plan.databaseOptions,
        { busyTimeoutMs: 0 },
      ),
    );
    return { kind: plan.kind, value: true };
  }
  let preservationRequired: Error | undefined;
  try {
    return runOpenClawAgentWriteTransaction((database) => {
      callbacks.beforeMutation?.(database);
      // Retained Workers receive only the parent's current fact, including its absence.
      stageSessionEntryMaintenanceAgeFact(database.db, plan.input.ageFact);
      const maintenance = applySessionEntryMaintenanceInDatabase(
        database,
        plan.input,
        () => {
          if (plan.input.preservation === null) {
            preservationRequired = new Error("SQLite maintenance requires session preservation");
            throw preservationRequired;
          }
          return plan.input.preservation;
        },
        callbacks.onArchived,
      );
      if (maintenance.archived > 0 || maintenance.entryRemovals.length > 0) {
        callbacks.onCommit?.(database);
      }
      callbacks.beforeCommit?.(database);
      return {
        kind: plan.kind,
        value: maintenance,
        ageFact: readSessionEntryMaintenanceAgeFact(database.db, plan.input.maintenance),
      };
    }, plan.databaseOptions);
  } catch (error) {
    if (preservationRequired && error === preservationRequired) {
      // Candidate discovery requested protection before writes; the transaction has rolled back.
      return { kind: "maintenance-preservation-required" };
    }
    throw error;
  }
}
