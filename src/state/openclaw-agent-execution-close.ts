import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import {
  onSqliteWalCheckpoint,
  type SqliteWalCheckpointSnapshot,
} from "../infra/sqlite-wal-checkpoint.js";
import type { SqliteWorkerCloseReceipt } from "../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-lifecycle.js";
import type { AgentDatabaseExecutionIdentity } from "./openclaw-agent-execution-contract.js";

export function closeAgentDatabaseExecution({
  database,
  identity,
  closeDomain,
  releaseBorrow,
  releaseSharedBorrow,
}: {
  database: OpenClawAgentDatabase | undefined;
  identity: AgentDatabaseExecutionIdentity | undefined;
  closeDomain: () => void;
  releaseBorrow: (() => void) | undefined;
  releaseSharedBorrow: () => void;
}): SqliteWorkerCloseReceipt | undefined {
  let checkpoint: SqliteWalCheckpointSnapshot | undefined;
  const errors: unknown[] = [];
  for (const cleanup of [
    closeDomain,
    () => {
      if (!database) {
        return;
      }
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
    },
    () => releaseBorrow?.(),
    releaseSharedBorrow,
  ]) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw createSqliteLifecycleAggregateError(errors, "Agent database cleanup failed", errors[0]);
  }
  if (identity && checkpoint) {
    return {
      identity: {
        key: `file:${identity.physicalIdentity}`,
        canonicalPath: identity.nativeLocation,
      },
      incarnation: identity.incarnation,
      checkpoint,
    };
  }
  return undefined;
}
