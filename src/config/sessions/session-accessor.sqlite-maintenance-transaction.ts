import type { DatabaseSync } from "node:sqlite";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "../../state/openclaw-agent-db-identity.js";
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
  ReclamationDatabaseOptions,
  SessionEntryMaintenanceInput,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceMetadataResult,
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  invalidateSessionEntryMaintenanceAgeFact,
  applySessionEntryMaintenanceAgeChange,
  captureSessionEntryMaintenanceAgeFact,
  readSessionEntryMaintenanceNextAgeAt,
  type SessionEntryMaintenanceAgeCapture,
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

class MaintenancePreservationRequiredError extends Error {}

const ageOwners = new WeakMap<DatabaseSync, string>();
const ageCaptureIds = new WeakMap<SessionEntryMaintenanceAgeCapture, number>();
let nextAgeCaptureId = 0;

function prepareWorkerAgeFact(
  database: Pick<OpenClawAgentDatabase, "db">,
  plan: Extract<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>,
) {
  if (plan.ageOwner !== undefined && ageOwners.get(database.db) !== plan.ageOwner) {
    invalidateSessionEntryMaintenanceAgeFact(database.db);
    ageOwners.set(database.db, plan.ageOwner);
  }
  for (const change of plan.ageChanges ?? []) {
    applySessionEntryMaintenanceAgeChange(database.db, change);
  }
}

function captureWorkerAgeSnapshot(
  database: OpenClawAgentDatabase,
  maintenance: SessionEntryMaintenanceInput["maintenance"],
) {
  const revision = readSessionEntryCacheValidityToken(database.db);
  const capture = captureSessionEntryMaintenanceAgeFact(database.db, maintenance);
  let id = ageCaptureIds.get(capture);
  if (id === undefined) {
    id = ++nextAgeCaptureId;
    ageCaptureIds.set(capture, id);
  }
  return {
    incarnation: readOpenClawAgentDatabaseIdentity(database).incarnation,
    revision,
    capture: id,
  };
}

function readPreservation(input: SessionEntryMaintenanceInput) {
  if (input.preservation === null) {
    throw new MaintenancePreservationRequiredError(
      "SQLite maintenance requires session preservation",
    );
  }
  return input.preservation;
}

/** Retain the snapshot connection; its revision fences age facts, not unrelated row writes. */
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
      apply(
        current: OpenClawAgentDatabase,
        onArchived?: Parameters<typeof applySessionEntryMaintenanceInDatabase>[3],
      ) {
        claim.assertCurrent();
        const snapshotCurrent = cacheValidityTokensEqual(
          revision,
          readSessionEntryCacheValidityToken(database.db),
        );
        const maintenance = apply(current, onArchived);
        // Unrelated commits can change age/count hints without changing the selected victims.
        if (!snapshotCurrent) {
          invalidateSessionEntryMaintenanceAgeFact(current.db);
        }
        return maintenance;
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
    },
    plan.databaseOptions,
    { operationLabel: "session.maintenance.finalize" },
  );
}

export function runSessionMaintenanceMetadataInTransaction(
  plan: SessionMaintenanceMetadataCommand & { databaseOptions: ReclamationDatabaseOptions },
  callbacks: {
    beforeMutation?: (database: OpenClawAgentDatabase) => void;
    onCommit?: SqliteSessionReclamationCallbacks["onCommit"];
    beforeCommit?: (database: OpenClawAgentDatabase) => void;
    onArchived?: Parameters<typeof applySessionEntryMaintenanceInDatabase>[3];
  },
  prepared?: ReturnType<typeof prepareSessionMaintenanceInWorker>,
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
        { busyTimeoutMs: 0, operationLabel: "session.maintenance.statistics" },
      ),
    );
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
          let expectedSnapshotMatches = true;
          if (plan.expected) {
            const snapshot = captureWorkerAgeSnapshot(database, plan.maintenance);
            expectedSnapshotMatches =
              plan.expected.incarnation === snapshot.incarnation &&
              plan.expected.capture === snapshot.capture &&
              cacheValidityTokensEqual(plan.expected.revision, snapshot.revision);
          }
          if (!isOpenClawAgentDatabasePathCurrent(database) || !expectedSnapshotMatches) {
            return { kind: "maintenance-plan-stale" };
          }
          callbacks.beforeCommit?.(database);
          return {
            kind: "maintenance-age",
            nextAt: readSessionEntryMaintenanceNextAgeAt(database, plan.maintenance),
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
              () => readPreservation(plan.input),
              callbacks.onArchived,
            );
        if (maintenance.archived > 0 || maintenance.entryRemovals.length > 0) {
          callbacks.onCommit?.(database);
        }
        callbacks.beforeCommit?.(database);
        return {
          kind: plan.kind,
          value: maintenance,
          ageSnapshot: captureWorkerAgeSnapshot(database, plan.input.maintenance),
        };
      },
      plan.databaseOptions,
      { operationLabel: "session.maintenance.plan.write" },
    );
  } catch (error) {
    if (error instanceof SqliteReclamationInputsChangedError) {
      return { kind: "maintenance-plan-stale" };
    }
    if (error instanceof MaintenancePreservationRequiredError) {
      // Candidate discovery requested protection before writes; the transaction has rolled back.
      return { kind: "maintenance-preservation-required" };
    }
    throw error;
  }
}
