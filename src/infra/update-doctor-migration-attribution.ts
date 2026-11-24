import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { assertStateDatabaseAccessAllowed } from "./gateway-state-owner.js";
import { readSqliteBusyTimeout, runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import { SqliteCoordinatorError } from "./sqlite-lifecycle-errors.js";
import { beginSqliteConnectionExclusion } from "./sqlite-native-exclusion.js";
import { readSqliteSchemaCookie } from "./sqlite-schema-contract.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";
import type { UpdateDatabaseGenerationObservation } from "./update-database-generations.js";
import { readUpdateDoctorGeneration } from "./update-doctor-generation-reader.js";

export type UpdateDoctorMigrationCapture = {
  expected(pathname: string): UpdateDatabaseGenerationObservation | undefined;
  assertCurrent(): void;
  accept(pathname: string, before: string | null, after: string | null): void;
  refuse(message: string): void;
};
const captures = new AsyncLocalStorage<UpdateDoctorMigrationCapture>();

export function runWithUpdateDoctorMigrationCapture<T>(
  capture: UpdateDoctorMigrationCapture,
  operation: () => T,
): T {
  return captures.getStore() ? operation() : captures.run(capture, operation);
}

// The rebuilt form is directional: only the previously verified observation
// can authorize the same WAL commit with a reset index.
export function matchesUpdateDoctorGeneration(
  expected: UpdateDatabaseGenerationObservation,
  observed: UpdateDatabaseGenerationObservation,
): boolean {
  return (
    expected.generation === observed.generation ||
    expected.generation === observed.emptyReaderAlternate ||
    expected.rebuiltIndexAlternate === observed.generation
  );
}

/** Only a one-shot existing ledger writer opts in. Ordinary Doctor writes remain unknown. */
export function runUpdateDoctorAttributedStateWrite<T>(
  db: DatabaseSync,
  pathname: string,
  operation: () => T,
  close: () => void,
): T {
  const capture = captures.getStore();
  if (!capture) {
    throw new Error("Attributed update write requires its original Doctor capture.");
  }
  try {
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error("Attributed update write requires schema maintenance custody.");
    }
    const assertCurrent = () => {
      maintenance.assertAdmission();
      assertStateDatabaseAccessAllowed(pathname);
      capture.assertCurrent();
    };
    assertCurrent();
    const expected = capture.expected(pathname);
    if (typeof expected?.generation !== "string" || db.isTransaction) {
      throw new Error(
        "Attributed update write requires an existing captured source and settled writer.",
      );
    }
    const identity = fs.lstatSync(pathname);
    const before = readUpdateDoctorGeneration(pathname);
    assertCurrent();
    if (!matchesUpdateDoctorGeneration(expected, before)) {
      throw new Error("SQLite receipt source changed after update capture.");
    }
    // Attach WAL coordination in normal mode first, then retain exclusion through
    // the existing owner's transaction, checkpoint, and exact one-shot close.
    readSqliteSchemaCookie(db);
    try {
      runWithSqliteBusyTimeout(
        db,
        Math.max(readSqliteBusyTimeout(db), OPENCLAW_SQLITE_BUSY_TIMEOUT_MS),
        () => {
          beginSqliteConnectionExclusion(db);
          db.exec("ROLLBACK"); // sqlite-allow-raw -- Retain connection exclusion while the ledger starts its own transaction.
        },
      );
    } catch (error) {
      if (!isSqliteLockError(error)) {
        throw error;
      }
      throw new Error(
        "Update migration could not take exclusive access to " +
          pathname +
          ": another connection still has it open.",
        { cause: error },
      );
    }
    const locked = readUpdateDoctorGeneration(pathname);
    assertCurrent();
    if (!matchesUpdateDoctorGeneration(before, locked)) {
      throw new Error("SQLite receipt source changed before native exclusion.");
    }
    const value = operation();
    if (isPromiseLike(value) || db.isTransaction) {
      throw new Error("Attributed update write must commit synchronously.");
    }
    assertCurrent();
    truncateSqliteWal(db, pathname);
    try {
      close();
    } catch (error) {
      throw new SqliteCoordinatorError("Receipt writer cleanup failed", error);
    }
    const after = readUpdateDoctorGeneration(pathname);
    assertCurrent();
    const currentIdentity = fs.lstatSync(pathname);
    if (
      after.generation === null ||
      identity.dev !== currentIdentity.dev ||
      identity.ino !== currentIdentity.ino
    ) {
      throw new Error("Receipt source was replaced during publication.");
    }
    capture.accept(pathname, expected.generation, after.generation);
    return value;
  } catch (error) {
    capture.refuse("Predecessor stop receipt publication could not be verified.");
    throw error;
  }
}
