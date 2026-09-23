import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";

type MaintenanceAdmission = {
  admit: (operation: () => void) => Promise<void>;
  flush?: (assertCurrent: () => void) => void;
  cancel?: () => void;
};

const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalWriteAdmissions"),
  () => new WeakMap<DatabaseSync, MaintenanceAdmission>(),
);

export function registerSqliteWalWriteAdmission(
  database: DatabaseSync,
  admit: MaintenanceAdmission["admit"],
): void {
  admissions.set(database, { admit });
}

export function cancelSqliteWalWriteAdmission(database: DatabaseSync): void {
  admissions.get(database)?.cancel?.();
}

export function createSqliteWalMaintenanceScheduler(
  database: DatabaseSync,
  operation: (maxPages: number) => number,
  onError: (error: unknown) => void,
  pageBudget: number,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      const run = async () => {
        let remaining = pageBudget;
        while (remaining > 0) {
          let reclaimed = 0;
          const admitted = () => {
            reclaimed = operation(remaining);
          };
          const admission = admissions.get(database);
          if (admission) {
            await admission.admit(admitted);
          } else {
            admitted();
          }
          remaining -= reclaimed;
          if (reclaimed <= 0 || remaining <= 0) {
            return;
          }
          // Return both the native lock and FIFO custody before another page unit.
          await setImmediate();
        }
      };
      pending = run()
        .catch(onError)
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
}

/** Retained Workers drain timer work only while their parent grants write admission. */
export function registerDeferredSqliteWalWriteAdmission(
  database: DatabaseSync,
): (assertCurrent: () => void) => void {
  const existing = admissions.get(database)?.flush;
  if (existing) {
    return existing;
  }
  let pending:
    | { operation: () => void; resolve: () => void; reject: (error: unknown) => void }
    | undefined;
  const flush = (assertCurrent: () => void) => {
    const current = pending;
    pending = undefined;
    if (current) {
      try {
        assertCurrent();
        current.operation();
        current.resolve();
      } catch (error) {
        current.reject(error);
      }
    }
    // Maintenance can catch the primary error before returning to its admission owner.
    // Unsettled native state must still reach the caller that retains the writer.
    if (database.isOpen && database.isTransaction) {
      assertTransactionUsable(database);
    }
  };
  admissions.set(database, {
    admit: (operation) =>
      new Promise<void>((resolve, reject) => {
        pending = { operation, resolve, reject };
      }),
    flush,
    cancel: () => {
      pending?.resolve();
      pending = undefined;
    },
  });
  return flush;
}
