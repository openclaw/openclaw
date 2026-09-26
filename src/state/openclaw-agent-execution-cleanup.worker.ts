import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import {
  onSqliteWalCheckpoint,
  type SqliteWalCheckpointSnapshot,
} from "../infra/sqlite-wal-checkpoint.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { releaseExitedOpenClawAgentDatabaseLeaseInDatabase } from "./openclaw-agent-db-lease.js";
import { closeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-lifecycle.js";
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

/** Capture only this native close's checkpoint for the existing completion receipt. */
export function closeAgentDatabaseWithCheckpoint(
  database: OpenClawAgentDatabase | undefined,
): SqliteWalCheckpointSnapshot | undefined {
  if (!database) {
    return undefined;
  }
  let checkpoint: SqliteWalCheckpointSnapshot | undefined;
  const closingPath = sqliteReaderDatabasePathKey(database.path);
  const stopObserving = onSqliteWalCheckpoint((observation) => {
    if (observation.databasePath === closingPath) {
      checkpoint = {
        health: observation.health,
        observedAtNs: observation.observedAtNs,
      };
    }
  });
  try {
    closeOpenClawAgentDatabaseByPath(database.path, database.agentId);
  } finally {
    stopObserving();
  }
  return checkpoint;
}
