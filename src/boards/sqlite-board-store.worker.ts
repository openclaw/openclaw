import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readRefusedSessionSource } from "../config/sessions/session-entry-patch.worker.js";
import type { SessionSourcePredicate } from "../config/sessions/session-source-authority.js";
import { withSqlitePostCommitPublications } from "../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteDeferredTransactionSync,
  runSqliteWorkerTransactionSync,
} from "../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../infra/sqlite-worker-database-context.js";
import { getSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { getOpenClawAgentDatabaseIfOpen } from "../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../state/openclaw-agent-execution-domain.js";
import { BoardValidationError } from "./board-layout.js";
import { normalizeBoardWidgetPutParams } from "./board-store.js";
import type { BoardReadOperations, BoardWriteOperations } from "./sqlite-board-operations.js";
import {
  applyBoardOpsToDatabase,
  ensureBoardSchema,
  grantBoardWidgetInDatabase,
  hasBoardSession,
  putBoardWidgetInDatabase,
  readBoardSnapshotWithHtmlViewMetadata,
  readBoardWidgetDocument,
  type BoardSessionIdentity,
} from "./sqlite-board-store.kernel.js";

export type BoardWorkerInput =
  | "read"
  | {
      agentId: string;
      sessionKey: string;
      expectedSession: BoardSessionIdentity;
      sources: SessionSourcePredicate[];
    }
  | undefined;

export type BoardSourceRefusal = NonNullable<ReturnType<typeof readRefusedSessionSource>>;

export function bindSqliteWorkerBackend(
  input: BoardWorkerInput,
  context: SqliteWorkerDatabaseContext & {
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<BoardWriteOperations & BoardReadOperations> {
  const database = { db: context.database, path: context.databasePath };
  const prepared = input && input !== "read" ? input : undefined;
  const canonical =
    prepared &&
    getOpenClawAgentDatabaseIfOpen({
      agentId: prepared.agentId,
      path: context.databasePath,
      env: getSqliteWorkerStateContext().environment,
    });
  if (prepared && (!canonical || canonical.db !== context.database)) {
    throw new Error("Board publication lost its canonical database owner");
  }
  const admission = {
    ...context,
    admit(stage: "transaction" | "commit") {
      const refused =
        prepared && canonical && readRefusedSessionSource(canonical, prepared.sources);
      context.admit(
        stage,
        refused
          ? (request, dispatch) => {
              if (!isRecord(request.facts)) {
                throw new Error("Board admission omitted its database identity");
              }
              dispatch({ ...request, facts: { ...request.facts, boardSourceRefused: refused } });
            }
          : undefined,
      );
      if (refused) {
        throw new Error("Board source refusal was not rejected");
      }
    },
  };
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
      const assertSessionCurrent = () => {
        if (
          input &&
          input !== "read" &&
          (command.input.sessionKey !== input.sessionKey ||
            !hasBoardSession(database, input.sessionKey, input.expectedSession))
        ) {
          throw new BoardValidationError("invalid_operation", "board session changed; retry");
        }
      };
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
            admission,
            () => {
              assertSessionCurrent();
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
              withCommit(commit) {
                assertSessionCurrent();
                return commit();
              },
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
