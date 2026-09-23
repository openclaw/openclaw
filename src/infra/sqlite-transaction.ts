// Provides SQLite transactions with the ordinary subsystem warning policy.
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainThread, threadId } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { executeWithCachedStatement } from "./kysely-sync-cache-state.js";
import { readSqliteBusyTimeout, runWithSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import {
  assertTransactionUsable,
  reportSqliteTransactionWarning,
  runSqliteTransactionSync,
  transactionDiagnosticLabels,
  type SqliteTransactionOptions,
} from "./sqlite-transaction-core.js";

export {
  assertTransactionUsable,
  retainSqliteWriteAdmissionService,
  withSqliteWriteAdmissionService,
} from "./sqlite-transaction-core.js";
export type { SqliteTransactionOptions } from "./sqlite-transaction-core.js";

const transactionLog = createSubsystemLogger("sqlite/transaction");

/** The lifecycle lock precedes BEGIN, so transaction hold diagnostics cannot see this wait. */
export function logSlowSqliteCoordinatorWait(
  elapsedMs: number,
  options: Pick<SqliteTransactionOptions, "databaseLabel" | "operationLabel">,
): void {
  if (!isMainThread || elapsedMs <= 100) {
    return;
  }
  try {
    // Capture only slow waits, while the synchronous owner's call chain is still on the stack.
    const trace = new Error();
    Error.captureStackTrace(trace, logSlowSqliteCoordinatorWait);
    reportSqliteTransactionWarning(transactionLog, "slow SQLite coordinator lock wait", {
      async: false,
      caller: trace.stack
        ?.split("\n")
        .slice(1, 9)
        .map((frame) => frame.trim())
        .join(" <- "),
      ...transactionDiagnosticLabels(undefined, options),
      elapsedMs,
      isMainThread,
      pid: process.pid,
      threadId,
      thresholdMs: 100,
    });
  } catch {
    // Diagnostics cannot abandon an acquired coordinator or replace its admission error.
  }
}

/** Run synchronous reads against one deferred SQLite snapshot. */
export function runSqliteDeferredTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  return runSqliteTransactionSync(db, operation, "deferred", {
    ...options,
    logger: options?.logger ?? transactionLog,
  });
}

/** Pin an implicit read snapshot without requiring transaction-control authorization. */
export function runSqlitePinnedReadSnapshotSync<T>(db: DatabaseSync, operation: () => T): T {
  return executeWithCachedStatement(db, "PRAGMA schema_version", [], (statement) => {
    // sqlite-allow-raw: Stepping this pragma pins the connection's implicit read transaction.
    const snapshot = statement.iterate();
    try {
      const first = snapshot.next();
      if (first.done) {
        throw new Error("SQLite schema version query returned no row");
      }
      return operation();
    } finally {
      snapshot.return?.();
    }
  });
}

export function runSqliteImmediateTransactionSync<T>(
  db: DatabaseSync,
  operation: () => T,
  options?: SqliteTransactionOptions,
): T {
  return runSqliteTransactionSync(db, operation, "immediate", {
    ...options,
    logger: options?.logger ?? transactionLog,
  });
}

/** Prepare outside the transaction; yield for admission without replaying admitted writes. */
export async function runSqliteImmediateTransaction<T>(
  db: DatabaseSync,
  prepare: () => Promise<(() => T) | undefined>,
  options?: SqliteTransactionOptions,
  admit: (write: () => T) => T | Promise<T> = (write) => write(),
): Promise<T | undefined> {
  assertTransactionUsable(db);
  if (db.isTransaction) {
    throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
  }
  const deadline = performance.now() + readSqliteBusyTimeout(db);
  const inheritedDeadlineNs = options?.beginDeadlineNs;
  const remainingMs =
    inheritedDeadlineNs === undefined
      ? () => deadline - performance.now()
      : () => Number(inheritedDeadlineNs - process.hrtime.bigint()) / 1_000_000;
  let entered = false;
  while (true) {
    const operation = await prepare();
    assertTransactionUsable(db);
    if (db.isTransaction) {
      throw new Error("SQLite preparation left a transaction open");
    }
    if (!operation) {
      return undefined;
    }
    try {
      return await admit(() => {
        assertTransactionUsable(db);
        // Owner admission may wait; never join a transaction opened during that wait.
        if (db.isTransaction) {
          throw new Error("Asynchronous SQLite preparation cannot join an existing transaction");
        }
        return runWithSqliteBusyTimeout(
          db,
          0,
          (restore) =>
            runSqliteImmediateTransactionSync(
              db,
              () => {
                entered = true;
                restore();
                return operation();
              },
              options,
            ),
          { lockFailureReporting: "suppress" },
        );
      });
    } catch (error) {
      if (entered || !isSqliteLockError(error) || remainingMs() <= 0) {
        throw error;
      }
      // The synchronous helper restored connection policy and left no transaction.
      await sleep(Math.min(25, Math.max(0, remainingMs())));
      assertTransactionUsable(db);
      if (remainingMs() <= 0) {
        throw error;
      }
    }
  }
}
