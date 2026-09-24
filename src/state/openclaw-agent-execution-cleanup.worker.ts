import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { releaseExitedOpenClawAgentDatabaseLeaseInDatabase } from "./openclaw-agent-db-lease.js";
import { requireOpenClawStateDatabaseIdentity } from "./openclaw-state-db-cache.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "./openclaw-state-db.js";
import type { OpenClawStateWorkerCleanupOperations } from "./openclaw-state-worker-contract.js";

export function executeAgentDatabaseCleanupCommand(
  command: SqliteWorkerCommand<
    Pick<OpenClawStateWorkerCleanupOperations, "agentDatabases.releaseExitedLease">
  >,
  database: OpenClawStateDatabase,
  env: NodeJS.ProcessEnv,
): void {
  runOpenClawStateWriteTransaction(
    (current) => {
      if (
        current.path !== command.input.sharedStatePath ||
        requireOpenClawStateDatabaseIdentity(current).key !== command.input.sharedStateIdentity
      ) {
        throw new Error("Retired agent cleanup cannot adopt a replacement shared database");
      }
      releaseExitedOpenClawAgentDatabaseLeaseInDatabase(current.db, command.input, () =>
        requestSqliteWorkerOperationAdmission({
          stage: "prepare",
          facts: "agent-integrity-invalidated",
        }),
      );
    },
    { database, path: database.path, env },
  );
}
