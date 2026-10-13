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
  /** Subsequent vacuum units keep FIFO yields without repeating once-per-pass maintenance. */
  continuation?: boolean;
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
  stopCheckpointTick?: () => void;
};

const admissions = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteWalWriteAdmissions"),
  () => new WeakMap<DatabaseSync, MaintenanceAdmission>(),
);

/** A worker-maintained writer never checkpoints inline; its maintenance owner ticks instead. */
export function registerSqliteWalWorkerMaintenance(
  database: DatabaseSync,
  execute: NonNullable<MaintenanceAdmission["execute"]>,
  cancel?: MaintenanceAdmission["cancel"],
): void {
  database.exec("PRAGMA wal_autocheckpoint = 0;"); // sqlite-allow-raw -- Checkpoint policy belongs to the WAL owner.
  const stopCheckpointTick = admissions.get(database)?.stopCheckpointTick;
  admissions.set(database, { execute, cancel });
  stopCheckpointTick?.();
}

export function isSqliteWalWorkerMaintained(database: DatabaseSync): boolean {
  return admissions.get(database)?.execute !== undefined;
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
  stopCheckpointTick: () => void,
): () => Promise<void> {
  const existingAdmission = admissions.get(database);
  admissions.set(database, { ...existingAdmission, stopCheckpointTick });
  let pending: Promise<void> | undefined;
  return () => {
    if (!pending) {
      const run = async () => {
        // A zero budget runs one checkpoint-only pass without vacuum units.
        let remaining = pageBudget();
        let continuation = false;
        while (true) {
          const request = prepare(remaining);
          // A delegated writer's checkpoint-only tick would round-trip through its worker
          // and race store replacement; worker connections to the same WAL tick inline.
          if (!request || (remaining === 0 && admissions.get(database)?.execute)) {
            return;
          }
          request.continuation = continuation;
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
          continuation = true;
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
    stopCheckpointTick: admissions.get(database)?.stopCheckpointTick,
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
