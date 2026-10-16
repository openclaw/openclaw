import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ReclamationDatabaseOptions,
  SessionEntryMaintenancePlan,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceMetadataResult,
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceAgeChange,
  readSessionEntryMaintenanceNextAgeAt,
  readSessionEntryMaintenanceAgeFact,
} from "./session-accessor.sqlite-maintenance-age.js";
import {
  applySessionEntryMaintenanceInDatabase,
  prepareSessionEntryMaintenanceInDatabase,
  refreshSessionPlannerStatisticsInDatabase,
} from "./session-accessor.sqlite-maintenance-store.js";
import { SqliteReclamationInputsChangedError } from "./session-accessor.sqlite-reclamation-worker-diagnostics.js";

type MaintenancePlan = Extract<
  SqliteSessionReclamationPlan,
  {
    kind:
      | "maintenance-plan"
      | "maintenance-finalize"
      | "maintenance-statistics"
      | "maintenance-age";
  }
>;

function prepareWorkerAgeFact(
  database: Pick<OpenClawAgentDatabase, "db">,
  plan: Extract<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>,
) {
  for (const change of plan.ageChanges ?? []) {
    applySessionEntryMaintenanceAgeChange(database.db, change);
  }
}

/** Retain the planning connection until selected rows are checked by the writer. */
export function prepareSessionMaintenanceInWorker(
  plan: Extract<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }> & {
    databaseOptions: ReclamationDatabaseOptions;
  },
) {
  const reader = retainOpenClawAgentDatabaseReadOnly(plan.databaseOptions);
  if (!reader.found) {
    throw new Error(`Cannot plan SQLite maintenance: ${reader.reason}`);
  }
  const { database, claim } = reader;
  try {
    claim.assertCurrent();
    prepareWorkerAgeFact(database, plan);
    const prepared = runSqliteDeferredTransactionSync(
      database.db,
      () =>
        prepareSessionEntryMaintenanceInDatabase(
          database,
          plan.input,
          () => plan.input.preservation,
        ),
      { databaseLabel: database.path, operationLabel: "session.maintenance.plan.read" },
    );
    return {
      apply(
        current: OpenClawAgentDatabase,
        onArchived?: Parameters<typeof applySessionEntryMaintenanceInDatabase>[3],
      ) {
        claim.assertCurrent();
        return prepared(current, onArchived);
      },
      release: claim.release,
    };
  } catch (error) {
    claim.release();
    throw error;
  }
}

export function reclaimSessionMaintenanceInTransaction(
  plan: MaintenancePlan,
  callbacks: SqliteSessionReclamationCallbacks,
  prepared?: ReturnType<typeof prepareSessionMaintenanceInWorker>,
): SqliteSessionReclamationResult {
  if (plan.kind !== "maintenance-finalize") {
    return runSessionMaintenanceMetadataInTransaction(plan, callbacks, prepared);
  }
  return runSqliteSessionDeletionTransaction(
    (database) => {
      callbacks.beforeMutation?.();
      const result = finalizeSessionMaintenanceInDatabase(database, plan);
      callbacks.onCommit?.(database, result);
      return result;
    },
    plan.databaseOptions,
    { operationLabel: "session.maintenance.finalize" },
  );
}

/** The native adapter and canonical executor share the same optimistic removal partition. */
export function finalizeSessionMaintenanceInDatabase(
  database: OpenClawAgentDatabase,
  plan: Extract<SqliteSessionReclamationPlan, { kind: "maintenance-finalize" }>,
): Extract<SqliteSessionReclamationResult, { kind: "maintenance-finalize" }> {
  const committedEntryIndices: number[] = [];
  const unchanged = plan.entries.filter((planned, index) => {
    const current = readExactSessionEntryRow(database, planned.sessionKey)?.entry;
    if (!sqliteSessionEntriesEqual(current, planned.expectedEntry)) {
      return false;
    }
    committedEntryIndices.push(index);
    return true;
  });
  const archivedTranscripts = deleteMaterializedSessionStatePlans(
    database,
    plan.materializedPlans,
    undefined,
    new Set(unchanged.map((entry) => entry.sessionKey)),
  );
  deletePlannedLifecycleArtifactEntries(database, unchanged);
  return {
    kind: plan.kind,
    value: {
      archivedTranscripts,
      committedEntryIndices,
    },
  };
}

export function runSessionMaintenanceMetadataInTransaction(
  plan: SessionMaintenanceMetadataCommand & { databaseOptions: ReclamationDatabaseOptions },
  callbacks: {
    beforeMutation?: (database: OpenClawAgentDatabase) => void;
    onCommit?: SqliteSessionReclamationCallbacks["onCommit"];
    beforeCommit?: (
      database: OpenClawAgentDatabase,
      maintenance?: SessionEntryMaintenancePlan,
    ) => void;
    onArchived?: Parameters<typeof applySessionEntryMaintenanceInDatabase>[3];
  },
  prepared?: ReturnType<typeof prepareSessionMaintenanceInWorker>,
): SessionMaintenanceMetadataResult {
  if (plan.kind === "maintenance-statistics") {
    const database = openOpenClawAgentDatabase(plan.databaseOptions);
    const run = () =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          callbacks.beforeMutation?.(current);
          refreshSessionPlannerStatisticsInDatabase(current);
          callbacks.onCommit?.(current);
          callbacks.beforeCommit?.(current);
        },
        plan.databaseOptions,
        { busyTimeoutMs: 0, operationLabel: "session.maintenance.statistics" },
      );
    if (isPostgresSqlConnection(database.db)) {
      run();
    } else {
      runWithSqliteBusyTimeout(database.db, 0, run);
    }
    return { kind: plan.kind, value: true };
  }
  try {
    return runOpenClawAgentWriteTransaction(
      (database) => {
        callbacks.beforeMutation?.(database);
        if (plan.kind === "maintenance-age") {
          for (const change of plan.ageChanges ?? []) {
            applySessionEntryMaintenanceAgeChange(database.db, change);
          }
          callbacks.beforeCommit?.(database);
          return {
            kind: "maintenance-age",
            nextAt: readSessionEntryMaintenanceNextAgeAt(database, plan.maintenance),
            ageFact: readSessionEntryMaintenanceAgeFact(database.db, plan.maintenance),
          };
        }
        if (!prepared) {
          prepareWorkerAgeFact(database, plan);
        }
        const maintenance = prepared
          ? prepared.apply(database, callbacks.onArchived)
          : applySessionEntryMaintenanceInDatabase(
              database,
              plan.input,
              () => plan.input.preservation,
              callbacks.onArchived,
            );
        if (maintenance.archived > 0 || maintenance.entryRemovals.length > 0) {
          callbacks.onCommit?.(database);
        }
        callbacks.beforeCommit?.(database, maintenance);
        return {
          kind: plan.kind,
          value: maintenance,
          nextAt: readSessionEntryMaintenanceNextAgeAt(database, plan.input.maintenance),
          ageFact: readSessionEntryMaintenanceAgeFact(database.db, plan.input.maintenance),
        };
      },
      plan.databaseOptions,
      { operationLabel: "session.maintenance.plan.write" },
    );
  } catch (error) {
    if (error instanceof SqliteReclamationInputsChangedError) {
      return { kind: "maintenance-plan-stale" };
    }
    throw error;
  }
}
