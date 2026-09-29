import type { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { assertTransactionUsable } from "./sqlite-transaction.js";
import type {
  SqliteWalCheckpointMode,
  SqliteWalCheckpointSnapshot,
} from "./sqlite-wal-checkpoint.js";

export type SqliteWalPeriodicRequest = {
  maxPages: number;
  checkpointMode: SqliteWalCheckpointMode;
  checkpoint?: SqliteWalCheckpointSnapshot;
};

export type SqliteWalPeriodicResult = {
  reclaimedPages: number;
  checkpoint?: SqliteWalCheckpointSnapshot;
};

type MaintenanceAdmission = {
  admit?: (operation: () => void) => Promise<void>;
  execute?: (request: SqliteWalPeriodicRequest) => Promise<SqliteWalPeriodicResult | undefined>;
  flush?: (assertCurrent: () => void) => void;
  cancel?: () => void | Promise<void>;
};

const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalWriteAdmissions"),
  () => new WeakMap<DatabaseSync, MaintenanceAdmission>(),
);

// Inline automatic checkpoints run on the committing connection; while a reader
// keeps the log from resetting, every later commit above this threshold retries
// one and syncs the database file. It matches the 64 MiB WAL recycling limit and
// only bounds a writer whose checkpoints nobody else runs.
export const SQLITE_WAL_INLINE_CHECKPOINT_VALVE_PAGES = 16_384;

/** A worker-maintained writer never checkpoints inline; its maintenance owner ticks instead. */
export function registerSqliteWalWorkerMaintenance(
  database: DatabaseSync,
  execute: NonNullable<MaintenanceAdmission["execute"]>,
  cancel?: MaintenanceAdmission["cancel"],
): void {
  database.exec("PRAGMA wal_autocheckpoint = 0;"); // sqlite-allow-raw -- Checkpoint policy belongs to the WAL owner.
  admissions.set(database, {
    execute,
    cancel: () => {
      // Without its worker the writer falls back to the bounded inline valve.
      if (database.isOpen && !database.isTransaction) {
        database.exec(`PRAGMA wal_autocheckpoint = ${SQLITE_WAL_INLINE_CHECKPOINT_VALVE_PAGES};`); // sqlite-allow-raw -- Restore the connection-local valve.
      }
      return cancel?.();
    },
  });
}

export function cancelSqliteWalWriteAdmission(database: DatabaseSync): void | Promise<void> {
  return admissions.get(database)?.cancel?.();
}

export function createSqliteWalMaintenanceScheduler(
  database: DatabaseSync,
  operation: (request: SqliteWalPeriodicRequest) => SqliteWalPeriodicResult,
  prepare: (maxPages: number) => SqliteWalPeriodicRequest | undefined,
  observe: (snapshot: SqliteWalCheckpointSnapshot) => void,
  onError: (error: unknown) => void,
  pageBudget: () => number,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      const run = async () => {
        // A zero budget runs one checkpoint-only pass without vacuum units.
        let remaining = pageBudget();
        while (true) {
          const request = prepare(remaining);
          if (!request) {
            return;
          }
          let result: SqliteWalPeriodicResult | undefined;
          const admitted = () => {
            if (prepare(remaining)) {
              result = operation(request);
            }
          };
          const admission = admissions.get(database);
          if (admission?.execute) {
            result = await admission.execute(request);
            if (!prepare(remaining)) {
              return;
            }
            if (result?.checkpoint) {
              observe(result.checkpoint);
            }
          } else if (admission?.admit) {
            await admission.admit(admitted);
          } else {
            admitted();
          }
          const reclaimed = result?.reclaimedPages ?? 0;
          remaining -= reclaimed;
          if (reclaimed <= 0 || remaining <= 0) {
            return;
          }
          // Return both the native lock and FIFO custody before another page unit.
          await setImmediate();
        }
      };
      pending = run()
        .catch((error: unknown) => {
          if (prepare(0)) {
            onError(error);
          }
        })
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
