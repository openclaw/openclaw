import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionSourcePredicate } from "../config/sessions/session-source-authority.js";
import { readSessionSourceValidation } from "../config/sessions/session-source-predicate.worker.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
} from "../infra/sqlite-transaction.js";
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
      sources: SessionSourcePredicate[];
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
  const admission = {
    ...context,
    admit(stage: "transaction" | "commit") {
      const validation =
        input && canonical && readSessionSourceValidation(canonical, input.sources);
      context.admit(
        stage,
        validation
          ? (request, dispatch) => {
              if (!isRecord(request.facts)) {
                throw new Error("Board admission omitted its database identity");
              }
              dispatch({
                ...request,
                facts: { ...request.facts, boardSourceValidation: validation },
              });
            }
          : undefined,
      );
      if (validation?.refusedSource) {
        throw new Error("Board source refusal was not rejected");
      }
    },
  };
  ensureBoardSchema(database);
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Board publication scope is closed");
      }
      if (input && command.input.sessionKey !== input.sessionKey) {
        throw new BoardValidationError("invalid_operation", "board session changed; retry");
      }
      // Nested actor publication scopes flush after this receipt has returned.
      const { result: value, changes } = captureSessionRowChanges(database.db, () =>
        withSqlitePostCommitPublications(database.db, () =>
          runSqliteWorkerTransactionSync(
            admission,
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
