import { collectSynchronousErrors } from "../infra/error-graph-internal.js";
import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../infra/sqlite-lifecycle-errors.js";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import {
  onSqliteWalCheckpoint,
  type SqliteWalCheckpointSnapshot,
} from "../infra/sqlite-wal-checkpoint.js";
import {
  SQLITE_WORKER_CLOSE_RECEIPT,
  SqliteWorkerOpenRefusedError,
  type SqliteWorkerCloseReceipt,
  type SqliteWorkerPreparedBackend,
} from "../infra/sqlite-worker-contract.js";
import { currentSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { stopAgentDatabaseWalMaintenance } from "./openclaw-agent-db-close.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import { closeOpenClawAgentDatabaseByPath } from "./openclaw-agent-db-lifecycle.js";
import { isOpenClawAgentDatabaseOpen } from "./openclaw-agent-db.js";
import type {
  AgentDatabaseFileExecutionIdentity,
  AgentDatabaseFileExecutionOpen,
  AgentDatabaseOperations,
} from "./openclaw-agent-execution-contract.js";

type AgentDatabaseExecutionCloseState = {
  database: OpenClawAgentDatabase | undefined;
  identity: AgentDatabaseFileExecutionIdentity | undefined;
  releasePreparations: readonly (() => void)[];
  closeDomain: () => void;
  releaseBorrow: (() => void) | undefined;
};

/**
 * True for an explicit pre-open refusal, and for the host refusing an existing database's open
 * (for example, for a cancelled caller) once the opener closed its handle. Neither leaves native
 * state for Worker retirement to reclaim. A create-capable caller also captures an existing
 * file's identity, so only an absent file (`path:` identity) is a cold creation; a refused cold
 * creation still retires the Worker, so its cleanup fences readers of the partly created file.
 */
export function isOpenRefusalWithoutHandle(
  error: unknown,
  opening: AgentDatabaseFileExecutionOpen,
): boolean {
  return (
    error instanceof SqliteWorkerOpenRefusedError ||
    (!opening.creatingIdentity?.key.startsWith("path:") &&
      currentSqliteWorkerOperationAdmission.getStore()?.owner.refusal === error &&
      !isOpenClawAgentDatabaseOpen(opening.databasePath))
  );
}

/** Keep the native receipt and both cleanup modes with the same retirement owner. */
export function createAgentDatabaseExecutionCloser(
  capture: () => AgentDatabaseExecutionCloseState & {
    sharedBorrow: { release(): void; releaseAsync(): Promise<void> } | undefined;
  },
) {
  let receipt: SqliteWorkerCloseReceipt | undefined;
  return {
    [SQLITE_WORKER_CLOSE_RECEIPT]: () => receipt,
    closeAfterFailedOpen() {
      const { sharedBorrow, ...state } = capture();
      receipt = undefined;
      receipt = closeAgentDatabaseExecution({
        ...state,
        releaseSharedBorrow: () => sharedBorrow?.release(),
      });
    },
    async close() {
      const { sharedBorrow, ...state } = capture();
      receipt = undefined;
      if (state.database) {
        await stopAgentDatabaseWalMaintenance(state.database);
      }
      const errors: unknown[] = [];
      try {
        receipt = closeAgentDatabaseExecution({ ...state, releaseSharedBorrow: () => {} });
      } catch (error) {
        errors.push(error);
      }
      try {
        await sharedBorrow?.releaseAsync();
      } catch (error) {
        errors.push(error);
      }
      throwSqliteLifecycleErrors(errors, "Agent database cleanup failed");
    },
  };
}

function closeAgentDatabaseExecution({
  database,
  identity,
  releasePreparations,
  closeDomain,
  releaseBorrow,
  releaseSharedBorrow,
}: AgentDatabaseExecutionCloseState & {
  releaseSharedBorrow: () => void;
}): SqliteWorkerCloseReceipt | undefined {
  let checkpoint: SqliteWalCheckpointSnapshot | undefined;
  const errors = collectSynchronousErrors(
    [
      ...releasePreparations,
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
              lastCompletedAtNs: observation.lastCompletedAtNs,
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
    ],
    (cleanup) => cleanup(),
  );
  throwSqliteLifecycleErrors(errors, "Agent database cleanup failed");
  if (identity && (checkpoint || (database && isPostgresSqlConnection(database.db)))) {
    return {
      identity: {
        key: `file:${identity.physicalIdentity}`,
        canonicalPath: identity.nativeLocation,
      },
      incarnation: identity.incarnation,
      ...(checkpoint ? { checkpoint } : {}),
    };
  }
  return undefined;
}

/** Creation owns failed-open cleanup until the prepared native backend is handed off. */
export function prepareCreatedAgentDatabaseBackend(
  backend: SqliteWorkerPreparedBackend<AgentDatabaseOperations> & { closeAfterFailedOpen(): void },
  opening: AgentDatabaseFileExecutionOpen,
): SqliteWorkerPreparedBackend<AgentDatabaseOperations> {
  try {
    backend.execute({ type: "database.prepareWrite", input: undefined });
    backend.assertSettled?.();
    return backend;
  } catch (error) {
    try {
      backend.closeAfterFailedOpen();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Agent creation and cleanup failed",
        error,
      );
    }
    // Cleanup closed every handle, so a host refusal reaches the broker as a refused open.
    if (
      !(error instanceof SqliteWorkerOpenRefusedError) &&
      isOpenRefusalWithoutHandle(error, opening)
    ) {
      throw new SqliteWorkerOpenRefusedError(error);
    }
    throw error;
  }
}
