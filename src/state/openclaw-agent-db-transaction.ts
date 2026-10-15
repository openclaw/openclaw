import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  runSqliteImmediateTransaction,
  type SqliteTransactionOptions,
} from "../infra/sqlite-transaction.js";
import {
  assertAgentDeletionDatabaseCleanupAccess,
  getAgentDeletionDatabaseCleanup,
} from "./agent-deletion-cleanup.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import { retainAgentDatabase } from "./openclaw-agent-db-lifecycle.js";
import { getOpenClawAgentDatabaseIfOpen, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";

/** Yield only for BEGIN admission; admitted writes and publications are never replayed. */
export async function runOpenClawAgentWriteWithYieldingAdmission<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
  transactionOptions: Pick<
    SqliteTransactionOptions,
    "operationLabel" | "slowTransactionHoldMs"
  > = {},
): Promise<T | undefined> {
  const captured = {
    ...options,
    env: cloneEnvWithPlatformSemantics(options.env ?? process.env),
  };
  const database = openOpenClawAgentDatabase(captured);
  captured.path = database.path;
  const release = retainAgentDatabase(database.db);
  try {
    return await runSqliteImmediateTransaction(
      database.db,
      async () => () => {
        assertAgentDeletionDatabaseCleanupAccess(database, captured);
        return operation(database);
      },
      {
        ...transactionOptions,
        busyTimeoutMs: readSqliteBusyTimeout(database.db),
        databaseLabel: database.path,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
        withCommit: getAgentDeletionDatabaseCleanup(captured)?.withCommit,
      },
      (write) => {
        if (getOpenClawAgentDatabaseIfOpen(captured) !== database) {
          throw new Error(`Agent database closed or replaced before write: ${database.path}`);
        }
        // BEGIN yields; admitted writes retain the connection's bounded COMMIT wait for readers.
        return withSqlitePostCommitPublications(database.db, write);
      },
    );
  } finally {
    release();
  }
}
