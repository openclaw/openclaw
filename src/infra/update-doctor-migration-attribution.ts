import { AsyncLocalStorage } from "node:async_hooks";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import type { PostgresSyncConnection } from "./postgres-sync/connection.js";

export type UpdateDoctorMigrationCapture = {
  expected(pathname: string): string | null | undefined;
  assertCurrent(): void;
  accept(pathname: string, before: string, after: string): void;
  refuse(message: string): void;
};

const captures = new AsyncLocalStorage<UpdateDoctorMigrationCapture>();

/** Doctor's existing maintenance interval owns the publication receipt. */
export function runWithUpdateDoctorMigrationCapture<T>(
  capture: UpdateDoctorMigrationCapture,
  operation: () => T,
): T {
  return captures.run(capture, operation);
}

/** Called inside the engine's migration transaction, before its first mutation. */
export function beginUpdatePostgresMigration(
  db: PostgresSyncConnection,
  assertMigrationCurrent?: () => void,
) {
  const capture = captures.getStore();
  const pathname = db.anchor.location();
  const expected = pathname && capture?.expected(pathname);
  if (!capture || !pathname || typeof expected !== "string") {
    return undefined;
  }
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    capture.refuse("PostgreSQL migration did not retain schema maintenance custody.");
    return undefined;
  }
  const assertCurrent = () => {
    maintenance.assertAdmission();
    if (assertMigrationCurrent) {
      assertMigrationCurrent();
    } else {
      maintenance.assertDatabaseAccess(pathname);
    }
    capture.assertCurrent();
  };
  assertCurrent();
  // The bridge locks tables and sequences before reading, excluding ordinary SQL writers too.
  const before = db.readRecoveryGeneration(true);
  if (before !== expected) {
    capture.refuse("PostgreSQL changed before migration acquired native custody.");
    throw new Error("PostgreSQL migration source changed after update capture.");
  }
  let publish: (() => void) | undefined;
  return {
    beforeCommit() {
      assertCurrent();
      const after = db.readRecoveryGeneration();
      publish = () => capture.accept(pathname, before, after);
      assertCurrent();
    },
    committed() {
      assertCurrent();
      // The postimage was read under the transaction's native locks. A later writer
      // is detected by the maintenance interval's existing final generation check.
      publish?.();
    },
  };
}
