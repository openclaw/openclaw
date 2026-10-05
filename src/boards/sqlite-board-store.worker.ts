import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteWorkerTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../infra/sqlite-worker-database-context.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { normalizeBoardWidgetPutParams } from "./board-store.js";
import type { BoardReadOperations, BoardWriteOperations } from "./sqlite-board-operations.js";
import {
  applyBoardOpsToDatabase,
  ensureBoardSchema,
  grantBoardWidgetInDatabase,
  putBoardWidgetInDatabase,
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetDocument,
} from "./sqlite-board-store.kernel.js";

export function bindSqliteWorkerBackend(
  input: unknown,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<BoardWriteOperations & BoardReadOperations> {
  const database = { db: context.database, path: context.databasePath };
  if (input !== "read") {
    ensureBoardSchema(database);
  }
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Board publication scope is closed");
      }
      if (command.type === "boards.readSnapshot" || command.type === "boards.readWidgetDocument") {
        return runSqliteDeferredTransactionSync(
          database.db,
          () => {
            context.admit("transaction");
            return command.type === "boards.readSnapshot"
              ? readBoardSnapshotWithHtmlViewMetadata(database, command.input.sessionKey)
              : readBoardWidgetDocument(
                  database,
                  command.input.sessionKey,
                  command.input.name,
                  command.input.contentKind,
                );
          },
          {
            databaseLabel: database.path,
            operationLabel: command.type,
            withCommit(commit) {
              context.admit("commit");
              return commit();
            },
          },
        );
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
        const value = withSqlitePostCommitPublications(database.db, () =>
          runSqliteWorkerTransactionSync(
            context,
            () => {
              if (command.type === "boards.applyOps") {
                return applyBoardOpsToDatabase(
                  database,
                  command.input.sessionKey,
                  command.input.ops,
                );
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
          ),
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
