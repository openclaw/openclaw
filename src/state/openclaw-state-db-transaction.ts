import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransactionSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Native and transformed SDK graphs may share the same transaction owner.
const managedStateTransactions = resolveGlobalSingleton(
  Symbol.for("openclaw.managedStateTransactions"),
  () => new WeakSet<DatabaseSync>(),
);
const stateCommitGuards = resolveGlobalSingleton(
  Symbol.for("openclaw.stateCommitGuards"),
  () => new AsyncLocalStorage<() => void>(),
);

/** Bind a live initiating owner to physical shared-state commits in this async operation. */
export async function withOpenClawStateCommitGuard<T>(
  assertCurrent: () => void,
  operation: () => T | Promise<T>,
): Promise<T> {
  const parent = stateCommitGuards.getStore();
  let active = true;
  const guard = () => {
    if (!active) {
      throw new Error("Shared-state commit guard is no longer active.");
    }
    parent?.();
    assertCurrent();
  };
  try {
    return await stateCommitGuards.run(guard, operation);
  } finally {
    active = false;
  }
}

/** Only the synchronous transaction owner may lend its uncommitted authority rows. */
export function isManagedStateTransaction(database: DatabaseSync): boolean {
  return database.isTransaction && managedStateTransactions.has(database);
}

export function runManagedStateTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
  options: SqliteTransactionOptions,
): T {
  if (database.isTransaction && !managedStateTransactions.has(database)) {
    throw new Error(
      "Cannot join an unmanaged shared-state transaction; enter through runOpenClawStateWriteTransaction before BEGIN.",
    );
  }
  const transaction = () =>
    withSqlitePostCommitPublications(database, () => {
      const outer = !database.isTransaction;
      const guard = stateCommitGuards.getStore();
      if (outer) {
        managedStateTransactions.add(database);
      }
      try {
        return runSqliteImmediateTransactionSync(
          database,
          operation,
          guard
            ? {
                ...options,
                withCommit: (commit) => {
                  const guardedCommit = () => {
                    guard();
                    commit();
                  };
                  return options.withCommit ? options.withCommit(guardedCommit) : guardedCommit();
                },
              }
            : options,
        );
      } finally {
        if (outer) {
          managedStateTransactions.delete(database);
        }
      }
    });
  return options.busyTimeoutMs === undefined
    ? transaction()
    : runWithSqliteBusyTimeout(database, options.busyTimeoutMs, transaction);
}
