import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../infra/sqlite-worker-database-context.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { normalizeBoardWidgetPutParams } from "./board-store.js";
import type { BoardWriteOperations } from "./sqlite-board-operations.js";
import {
  applyBoardOpsToDatabase,
  ensureBoardSchema,
  grantBoardWidgetInDatabase,
  putBoardWidgetInDatabase,
} from "./sqlite-board-store.kernel.js";

export function bindSqliteWorkerBackend(
  _input: unknown,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<BoardWriteOperations> {
  const database = { db: context.database, path: context.databasePath };
  ensureBoardSchema(database);
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Board publication scope is closed");
      }
      const changes: SessionRowChange[] = [];
      const unsubscribe = sessionChanges.subscribeFacts((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === command.input.sessionKey &&
          change.storePath === database.path
        ) {
          changes.push(change);
        }
      });
      try {
        const value = runSqliteWorkerTransactionSync(
          context,
          () => {
            if (command.type === "boards.applyOps") {
              return applyBoardOpsToDatabase(database, command.input.sessionKey, command.input.ops);
            }
            if (command.type === "boards.putWidget") {
              return putBoardWidgetInDatabase(
                database,
                command.input.sessionKey,
                normalizeBoardWidgetPutParams(command.input.params, command.input.sessionKey),
                command.input.viewGeneration,
              );
            }
            return grantBoardWidgetInDatabase(
              database,
              command.input.sessionKey,
              command.input.name,
              command.input.decision,
              command.input.revision,
              command.input.instanceId,
            );
          },
          {
            databaseLabel: database.path,
            operationLabel: command.type,
          },
        );
        return { value, changes };
      } finally {
        unsubscribe();
      }
    },
    assertSettled() {
      assertTransactionUsable(database.db);
      if (database.db.isTransaction) {
        throw new Error("Board publication left an unsettled transaction");
      }
    },
    close() {
      closed = true;
    },
  };
}
