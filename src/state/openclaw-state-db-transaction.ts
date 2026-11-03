import type { EngineConnection } from "../infra/sql-connection.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransactionSync,
  runSqliteSingleStatementSync,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

// Native and transformed SDK graphs may share the same transaction owner.
const managedStateTransactions = resolveGlobalSingleton(
  Symbol.for("openclaw.managedStateTransactions"),
  () => new WeakSet<EngineConnection>(),
);
/** Only the synchronous transaction owner may lend its uncommitted authority rows. */
export function isManagedStateTransaction(database: EngineConnection): boolean {
  return database.isTransaction && managedStateTransactions.has(database);
}

export function runManagedStateTransaction<T>(
  database: EngineConnection,
  operation: () => T,
  options: SqliteTransactionOptions & { singleStatement?: true },
): T {
  if (database.isTransaction && !managedStateTransactions.has(database)) {
    throw new Error(
      "Cannot join an unmanaged shared-state transaction; enter through runOpenClawStateWriteTransaction before BEGIN.",
    );
  }
  const transaction = () =>
    withSqlitePostCommitPublications(database, () => {
      const outer = !database.isTransaction;
      if (outer) {
        managedStateTransactions.add(database);
      }
      try {
        return options.singleStatement
          ? runSqliteSingleStatementSync(database, operation)
          : runSqliteImmediateTransactionSync(database, operation, options);
      } finally {
        if (outer) {
          managedStateTransactions.delete(database);
        }
      }
    });
  return options.busyTimeoutMs === undefined || isPostgresSqlConnection(database)
    ? transaction()
    : runWithSqliteBusyTimeout(database, options.busyTimeoutMs, transaction);
}
