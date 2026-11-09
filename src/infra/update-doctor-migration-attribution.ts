import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { assertStateDatabaseAccessAllowed } from "./gateway-state-owner.js";
import { SqliteCoordinatorError } from "./sqlite-lifecycle-errors.js";
import { beginSqliteConnectionExclusion } from "./sqlite-native-exclusion.js";
import { runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import { readSqliteSchemaCookie } from "./sqlite-schema-contract.js";
import { truncateSqliteWal } from "./sqlite-wal-checkpoint.js";

export type UpdateDoctorMigrationCapture = {
  expected(pathname: string): string | null | undefined;
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

/** Raw descriptors stay in the child even while our native writer holds exclusion. */
export function readUpdateDoctorGeneration(pathname: string): {
  generation: string | null;
  emptyReaderAlternate?: string;
} {
  const value: unknown = JSON.parse(
    runSqliteReadOnlyWorkerSync(pathname, undefined, "update-generation"),
  );
  if (!value || typeof value !== "object" || !("generation" in value)) {
    throw new Error("Database generation child returned an invalid observation.");
  }
  const generation = value.generation;
  const emptyReaderAlternate =
    "emptyReaderAlternate" in value ? value.emptyReaderAlternate : undefined;
  if (
    (generation !== null &&
      (typeof generation !== "string" || !/^[a-f0-9]{64}$/u.test(generation))) ||
    (emptyReaderAlternate !== undefined &&
      (typeof emptyReaderAlternate !== "string" || !/^[a-f0-9]{64}$/u.test(emptyReaderAlternate)))
  ) {
    throw new Error("Database generation child returned an invalid observation.");
  }
  return { generation, ...(emptyReaderAlternate !== undefined ? { emptyReaderAlternate } : {}) };
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
    if (typeof expected !== "string" || db.isTransaction) {
      throw new Error(
        "Attributed update write requires an existing captured source and settled writer.",
      );
    }
    const identity = fs.lstatSync(pathname);
    const before = readUpdateDoctorGeneration(pathname);
    assertCurrent();
    if (before.generation !== expected && before.emptyReaderAlternate !== expected) {
      throw new Error("SQLite receipt source changed after update capture.");
    }
    // Attach WAL coordination in normal mode first, then retain exclusion through
    // the existing owner's transaction, checkpoint, and exact one-shot close.
    readSqliteSchemaCookie(db);
    beginSqliteConnectionExclusion(db);
    db.exec("ROLLBACK"); // sqlite-allow-raw -- Retain connection exclusion while the ledger starts its own transaction.
    const locked = readUpdateDoctorGeneration(pathname);
    assertCurrent();
    if (
      locked.generation !== before.generation &&
      locked.emptyReaderAlternate !== before.generation
    ) {
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
    capture.accept(pathname, expected, after.generation);
    return value;
  } catch (error) {
    capture.refuse("Predecessor stop receipt publication could not be verified.");
    throw error;
  }
}
