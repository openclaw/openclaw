import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import type { SynchronousSqliteCallback } from "../infra/sqlite-transaction-types.js";
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
  ensureBoardComponentIdentityInDatabase,
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
      // Keep each command's result paired with its own receipt type.
      const commit = <T>(operation: SynchronousSqliteCallback<T>) => {
        const { result: value, changes } = captureSessionRowChanges(database.db, () =>
          withSqlitePostCommitPublications(database.db, () =>
            runSqliteWorkerTransactionSync<T>(context, operation, {
              databaseLabel: database.path,
              operationLabel: command.type,
            }),
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
      };
      if (command.type === "boards.ensureComponentIdentity") {
        return commit(() =>
          ensureBoardComponentIdentityInDatabase(
            database,
            command.input.sessionKey,
            command.input.name,
            command.input.instanceId,
            command.input.proposedId,
            input?.expectedSession,
          ),
        );
      }
      if (command.type === "boards.applyOps") {
        return commit(() =>
          applyBoardOpsToDatabase(
            database,
            command.input.sessionKey,
            command.input.ops,
            input?.expectedSession,
            command.input.component,
          ),
        );
      }
      if (command.type === "boards.putWidget") {
        return commit(() =>
          putBoardWidgetInDatabase(
            database,
            command.input.sessionKey,
            normalizeBoardWidgetPutParams(command.input.params, command.input.sessionKey),
            command.input.viewGeneration,
            input?.expectedSession,
          ),
        );
      }
      return commit(() =>
        grantBoardWidgetInDatabase(
          database,
          command.input.sessionKey,
          command.input.name,
          command.input.decision,
          command.input.revision,
          command.input.instanceId,
          input?.expectedSession,
        ),
      );
    },
  });
}
