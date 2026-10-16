import { ensureStatePostgresFragment, isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import {
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  withOpenClawStateStartupMigrationCheckpointDatabase,
} from "../state/openclaw-state-db.js";
import { isOpenClawStateWriteContentionError } from "../state/openclaw-state-ownership.js";
import { withEngineStoreAdmission } from "./database-engine/admission-scope.js";
import { formatErrorMessage } from "./errors.js";
import type { EngineConnection } from "./sql-connection.js";
import { isPostgresSqlConnection } from "./sql-connection.js";
import { assertSqliteIntegrity, SqliteRepairableForeignKeyError } from "./sqlite-integrity.js";
import type { UpdateRunLedgerOptions } from "./update-run-codec.js";
import { updateRunLedgerSchema } from "./update-run-write.js";

export class UpdateRunAdmissionBusyError extends Error {
  readonly reason = "update-ledger-busy";
}

export function runUpdateRunAdmission<T>(
  operation: (db: EngineConnection, recoveryChanges: string[]) => T,
  options: UpdateRunLedgerOptions,
  recoverTaskDeliveryOrphans: boolean,
  assertCurrent?: (stage: "transaction" | "commit") => void,
): T {
  if (options.database) {
    throw new Error("Update run admission requires its own writable connection");
  }
  const admitted = (db: EngineConnection, recoveryChanges: string[]) => {
    const result = operation(db, recoveryChanges);
    assertCurrent?.("commit");
    return result;
  };
  // Admission precedes managed shutdown. An older serving Gateway must not
  // force diagnostic writes through this candidate's runtime migrations.
  // Once a file exists, failures remain failures; never retry via bootstrap.
  // Pre-v19 orphan recovery must remain here: schema-19 table retirement waits
  // for managed shutdown and cannot run just to open the old driver's ledger.
  // PostgreSQL inspects its admitted store directly; the anchor is not a SQLite state snapshot.
  const read = isStatePostgres()
    ? withExistingOpenClawStateDatabaseCurrentReadOnly
    : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
  const inspect = () =>
    read(({ db, path }) => {
      if (isPostgresSqlConnection(db)) {
        return { repairable: undefined };
      }
      try {
        assertSqliteIntegrity(db, path);
        return { repairable: undefined };
      } catch (error) {
        if (!(error instanceof SqliteRepairableForeignKeyError)) {
          throw error;
        }
        return { repairable: error };
      }
    }, options);
  const inspection = isStatePostgres() ? withEngineStoreAdmission(inspect) : inspect();
  assertCurrent?.("transaction");
  if (inspection) {
    if (inspection.repairable && !recoverTaskDeliveryOrphans) {
      throw inspection.repairable;
    }
    try {
      return runExistingOpenClawStateWriteTransaction(
        ({ db, recoveryChanges }) => admitted(db, recoveryChanges),
        options,
        {
          schemaSql: updateRunLedgerSchema,
          operationLabel: "update.run",
          busyTimeoutMs: options.busyTimeoutMs,
          initializeAdditiveSchema: true,
          ...(inspection.repairable ? { recoverTaskDeliveryOrphans: true } : {}),
        },
      );
    } catch (error) {
      if (inspection.repairable) {
        throw new Error(
          `${inspection.repairable.message} Update admission could not complete recovery: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }
      if (isOpenClawStateWriteContentionError(error)) {
        throw new UpdateRunAdmissionBusyError(
          "Update history is busy. Admission was deferred; previous history is unchanged. Retry `openclaw update` after the current database writer finishes.",
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (isStatePostgres()) {
    return withOpenClawStateStartupMigrationCheckpointDatabase((db) => {
      if (!isPostgresSqlConnection(db)) {
        throw new Error("PostgreSQL update admission requires its selected engine");
      }
      ensureStatePostgresFragment(db, "update_runs");
      return admitted(db, []);
    }, options);
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      // Feature-local, idempotent DDL shares the write transaction; a failed write also rolls back first use.
      db.exec(updateRunLedgerSchema); // sqlite-allow-raw -- Canonical first-use ledger DDL in its write transaction.
      return admitted(db, []);
    },
    options,
    { operationLabel: "update.run" },
  );
}
