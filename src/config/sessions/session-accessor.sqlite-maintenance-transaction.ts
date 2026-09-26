import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";
import {
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  partitionUnchangedPlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionEntryMaintenanceInput,
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
  prepareSessionEntryMaintenanceInDatabase,
  refreshSessionPlannerStatisticsInDatabase,
} from "./session-accessor.sqlite-maintenance-store.js";

type MaintenancePlan = Extract<
  SqliteSessionReclamationPlan,
  {
    kind: "maintenance-plan" | "maintenance-finalize" | "maintenance-statistics";
  }
>;

class MaintenancePreservationRequiredError extends Error {}

function readPreservation(input: SessionEntryMaintenanceInput) {
  if (input.preservation === null) {
    throw new MaintenancePreservationRequiredError(
      "SQLite maintenance requires session preservation",
    );
  }
  return input.preservation;
}

/** Retain the snapshot's connection until its revision is checked inside the final writer. */
export function prepareSessionMaintenanceInWorker(
  plan: Extract<MaintenancePlan, { kind: "maintenance-plan" }>,
) {
  const reader = retainOpenClawAgentDatabaseReadOnly(plan.databaseOptions);
  if (!reader.found) {
    throw new Error(`Cannot plan SQLite maintenance: ${reader.reason}`);
  }
  const { database, claim } = reader;
  try {
    claim.assertCurrent();
    stageSessionEntryMaintenanceAgeFact(database.db, plan.input.ageFact);
    const revision = readSessionEntryCacheValidityToken(database.db);
    let apply: ReturnType<typeof prepareSessionEntryMaintenanceInDatabase>;
    try {
      apply = runSqliteDeferredTransactionSync(
        database.db,
        () =>
          prepareSessionEntryMaintenanceInDatabase(database, plan.input, () =>
            readPreservation(plan.input),
          ),
        { databaseLabel: database.path, operationLabel: "session.maintenance.plan.read" },
      );
    } catch (error) {
      if (!(error instanceof MaintenancePreservationRequiredError)) {
        throw error;
      }
      apply = () => {
        throw error;
      };
    }
    return {
      apply(current: OpenClawAgentDatabase) {
        claim.assertCurrent();
        if (!cacheValidityTokensEqual(revision, readSessionEntryCacheValidityToken(database.db))) {
          return undefined;
        }
        return apply(current);
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
  if (plan.kind === "maintenance-statistics") {
    const database = openOpenClawAgentDatabase(plan.databaseOptions);
    runWithSqliteBusyTimeout(database.db, 0, () =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          callbacks.beforeMutation?.();
          refreshSessionPlannerStatisticsInDatabase(current);
          callbacks.onCommit?.(current);
        },
        plan.databaseOptions,
        { busyTimeoutMs: 0 },
      ),
    );
    return { kind: plan.kind, value: true };
  }
  if (plan.kind === "maintenance-plan") {
    try {
      return runOpenClawAgentWriteTransaction(
        (database) => {
          callbacks.beforeMutation?.();
          // Retained Workers receive only the parent's current fact, including its absence.
          stageSessionEntryMaintenanceAgeFact(database.db, plan.input.ageFact);
          const maintenance = prepared
            ? prepared.apply(database)
            : applySessionEntryMaintenanceInDatabase(database, plan.input, () =>
                readPreservation(plan.input),
              );
          if (!maintenance) {
            return { kind: "maintenance-plan-stale" };
          }
          if (maintenance.archived > 0 || maintenance.entryRemovals.length > 0) {
            callbacks.onCommit?.(database);
          }
          return {
            kind: plan.kind,
            value: maintenance,
            ageFact: readSessionEntryMaintenanceAgeFact(database.db, plan.input.maintenance),
          };
        },
        plan.databaseOptions,
        { operationLabel: "session.maintenance.plan.write" },
      );
    } catch (error) {
      if (error instanceof MaintenancePreservationRequiredError) {
        // Candidate discovery requested protection before writes; the transaction has rolled back.
        return { kind: "maintenance-preservation-required" };
      }
      throw error;
    }
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
