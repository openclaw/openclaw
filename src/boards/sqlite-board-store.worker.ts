import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import { runSqliteWorkerTransactionSync } from "../infra/sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "../infra/sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../infra/sqlite-worker-database-context.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { captureSessionRowChanges } from "../sessions/session-row-changes.js";
import { getOpenClawAgentDatabaseIfOpen } from "../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../state/openclaw-agent-execution-domain.js";
import { BoardValidationError } from "./board-layout.js";
import { normalizeBoardWidgetPutParams } from "./board-store.js";
import type { BoardWriteOperations } from "./sqlite-board-operations.js";
import {
  applyBoardOpsToDatabase,
  ensureBoardSchema,
  grantBoardWidgetInDatabase,
  putBoardWidgetInDatabase,
  type BoardSessionIdentity,
} from "./sqlite-board-store.kernel.js";

export type BoardWorkerInput =
  | {
      agentId: string;
      sessionKey: string;
      expectedSession: BoardSessionIdentity;
    }
  | undefined;

export function bindSqliteWorkerBackend(
  input: BoardWorkerInput,
  context: SqliteWorkerDatabaseContext & {
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<BoardWriteOperations> {
  const database = { db: context.database, path: context.databasePath };
  const canonical =
    input &&
    getOpenClawAgentDatabaseIfOpen({
      agentId: input.agentId,
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  if (input && (!canonical || canonical.db !== context.database)) {
    throw new Error("Board publication lost its canonical database owner");
  }
  ensureBoardSchema(database);
  return bindSqliteWorkerDatabase<BoardWriteOperations>(database.db, {
    execute(command) {
      if (input && command.input.sessionKey !== input.sessionKey) {
        throw new BoardValidationError("invalid_operation", "board session changed; retry");
      }
      // Nested actor publication scopes flush after this receipt has returned.
      const { result: value, changes } = captureSessionRowChanges(database.db, () =>
        withSqlitePostCommitPublications(database.db, () =>
          runSqliteWorkerTransactionSync(
            context,
            () => {
              if (command.type === "boards.applyOps") {
                return applyBoardOpsToDatabase(
                  database,
                  command.input.sessionKey,
                  command.input.ops,
                  input?.expectedSession,
                );
              }
              if (command.type === "boards.putWidget") {
                return putBoardWidgetInDatabase(
                  database,
                  command.input.sessionKey,
                  normalizeBoardWidgetPutParams(command.input.params, command.input.sessionKey),
                  command.input.viewGeneration,
                  input?.expectedSession,
                );
              }
              return grantBoardWidgetInDatabase(
                database,
                command.input.sessionKey,
                command.input.name,
                command.input.decision,
                command.input.revision,
                command.input.instanceId,
                input?.expectedSession,
              );
            },
            {
              databaseLabel: database.path,
              operationLabel: command.type,
            },
          ),
        ),
      );
      return {
        value,
        changes: changes.filter(
          (change) =>
            "sessionKey" in change &&
            change.sessionKey === command.input.sessionKey &&
            change.storePath === database.path,
        ),
      };
    },
  });
}
