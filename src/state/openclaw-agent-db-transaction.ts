import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
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
import {
  agentDatabaseLifecycle as cache,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { getOpenClawAgentDatabaseIfOpen, openOpenClawAgentDatabase } from "./openclaw-agent-db.js";

/** Yield only for BEGIN admission; admitted writes and publications are never replayed. */
export async function runOpenClawAgentWriteTransactionAsync<T>(
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
        const result = operation(database);
        if (!cache.incognito.has(database)) {
          ensureOpenClawAgentDatabasePermissions(database.path, captured);
        }
        return result;
      },
      {
        ...transactionOptions,
        busyTimeoutMs: 0,
        databaseLabel: database.path,
        operationLabel: transactionOptions.operationLabel ?? "agent.write",
        withCommit: getAgentDeletionDatabaseCleanup(captured)?.withCommit,
      },
      (write) => {
        if (getOpenClawAgentDatabaseIfOpen(captured) !== database) {
          throw new Error(`Agent database closed or replaced before write: ${database.path}`);
        }
        // Keep zero native wait through COMMIT too; the helper retains the original BEGIN budget.
        return runWithSqliteBusyTimeout(database.db, 0, () =>
          withSqlitePostCommitPublications(database.db, write),
        );
      },
    );
  } finally {
    release();
  }
}
