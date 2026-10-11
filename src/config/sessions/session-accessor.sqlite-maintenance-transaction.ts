import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import { sqliteSessionEntriesEqual } from "./session-accessor.sqlite-entry-equality.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import {
  cacheValidityTokensEqual,
  readSessionEntryCacheValidityToken,
} from "./session-accessor.sqlite-entry-revision.js";
import {
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  ReclamationDatabaseOptions,
  SessionEntryMaintenanceInput,
  SessionMaintenanceMetadataCommand,
  SessionMaintenanceMetadataResult,
  SessionMaintenanceReadCommand,
  SessionMaintenanceReadResult,
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  invalidateSessionEntryMaintenanceAgeFact,
  applySessionEntryMaintenanceAgeChange,
  readSessionEntryMaintenanceNextAgeAt,
} from "./session-accessor.sqlite-maintenance-age.js";
import {
  applySessionEntryMaintenanceInDatabase,
  prepareSessionEntryMaintenanceInDatabase,
  refreshSessionPlannerStatisticsInDatabase,
  type SessionEntryMaintenanceApply,
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

function prepareWorkerAgeFact(
  database: Pick<OpenClawAgentDatabase, "db">,
  plan: Extract<SessionMaintenanceMetadataCommand, { kind: "maintenance-plan" }>,
) {
  for (const change of plan.ageChanges ?? []) {
    applySessionEntryMaintenanceAgeChange(database.db, change);
  }
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
    let apply: SessionEntryMaintenanceApply;
    try {
      apply = runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const prepared = prepareSessionEntryMaintenanceInDatabase(database, plan.input, () =>
            readPreservation(plan.input),
          );
          return prepared.kind === "no-op" ? prepared.apply : prepared.captureMutation();
        },
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

/** No-op preparation observes existing storage without admitting a writer or retaining a snapshot. */
export function readSessionMaintenanceInWorker(
  plan: SessionMaintenanceReadCommand & { databaseOptions: ReclamationDatabaseOptions },
  capturedDatabase?: OpenClawAgentReadOnlyDatabase,
): SessionMaintenanceReadResult {
  const input = plan.kind === "maintenance-plan" ? plan.input : plan.readOnly?.input;
  if (!input) {
    throw new Error("Read-only maintenance age requires its original planning input");
  }
  try {
    const read = (database: OpenClawAgentReadOnlyDatabase) =>
      withSqlitePostCommitPublications(database.db, () =>
        runSqliteDeferredTransactionSync(
          database.db,
          (): SessionMaintenanceReadResult => {
            const observed = readOpenClawAgentDatabaseIdentity(database);
            const expected = plan.expectedIdentity;
            if (
              !expected.key.startsWith("file:") ||
              observed.identity !== expected.key.slice(5) ||
              (expected.birthtime !== undefined && observed.birthtime !== expected.birthtime)
            ) {
              throw new Error("Maintenance reader opened a different physical source");
            }
            assertExistingDatabaseIdentity(database.path, expected.key, expected.birthtime);
            if (plan.kind === "maintenance-plan") {
              prepareWorkerAgeFact(database, plan);
            } else {
              for (const change of plan.ageChanges ?? []) {
                applySessionEntryMaintenanceAgeChange(database.db, change);
              }
              // This is a scheduling hint, not authority to delete. A stale hint is
              // corrected by the next kick or periodic pass; deletion checks stay native.
              return {
                kind: "maintenance-age",
                nextAt: readSessionEntryMaintenanceNextAgeAt(database, plan.maintenance),
              };
            }
            const prepared = prepareSessionEntryMaintenanceInDatabase(database, input, () =>
              readPreservation(input),
            );
            if (prepared.kind === "write") {
              return { kind: "maintenance-write-required" };
            }
            return {
              kind: "maintenance-plan",
              value: prepared.value,
              readOnlyInput: input,
              nextAt: readSessionEntryMaintenanceNextAgeAt(database, input.maintenance),
            };
          },
          { databaseLabel: database.path, operationLabel: "session.maintenance.read" },
        ),
      );
    const result = capturedDatabase
      ? { found: true as const, value: read(capturedDatabase) }
      : withOpenClawAgentDatabaseReadOnly(read, plan.databaseOptions);
    if (!result.found) {
      throw new Error(`Cannot plan SQLite maintenance: ${result.reason}`);
    }
    return result.value;
  } catch (error) {
    if (error instanceof MaintenancePreservationRequiredError) {
      return {
        kind:
          plan.kind === "maintenance-plan"
            ? "maintenance-preservation-required"
            : "maintenance-plan-stale",
      };
    }
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
          nextAt: readSessionEntryMaintenanceNextAgeAt(database, plan.input.maintenance),
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
