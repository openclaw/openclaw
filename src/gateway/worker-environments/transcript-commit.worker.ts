import type { DatabaseSync } from "node:sqlite";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  applyPreparedTranscriptCommit,
  prepareTranscriptCommit,
  type PreparedTranscriptCommit,
} from "./transcript-commit.kernel.js";
import type {
  ApplyTranscriptCommitResult,
  CommittedAgentMessage,
  TranscriptCommitInput,
} from "./transcript-commit.types.js";

export type WorkerTranscriptOperations = {
  "transcript.prepare": {
    input: TranscriptCommitInput;
    output: ApplyTranscriptCommitResult;
  };
  "transcript.commit": {
    input: { messages: readonly CommittedAgentMessage[] };
    output: { result: ApplyTranscriptCommitResult; projectionNeedsReconcile: boolean };
  };
};

/** The canonical agent actor owns the connection and writer admission. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<WorkerTranscriptOperations> {
  let prepared: { input: TranscriptCommitInput; plan: PreparedTranscriptCommit } | undefined;
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Worker transcript domain is closed");
      }
      if (command.type === "transcript.prepare") {
        if (prepared) {
          throw new Error("Worker transcript batch is already prepared");
        }
        const input = {
          ...command.input,
          scope: {
            ...command.input.scope,
            storePath: context.databasePath,
            env: getSqliteWorkerStateContext().environment,
          },
        };
        if (command.input.scope.storePath !== context.databasePath) {
          throw new Error("Worker transcript target changed its database owner");
        }
        const plan = runSqliteDeferredTransactionSync(context.database, () =>
          prepareTranscriptCommit(input),
        );
        prepared = { input, plan };
        return plan.result;
      }
      if (!prepared) {
        throw new Error("Worker transcript batch was not prepared");
      }
      const { input, plan } = prepared;
      prepared = undefined;
      return runOpenClawAgentWriteTransaction(
        (database) => {
          if (database.db !== context.database) {
            throw new Error("Worker transcript lost its canonical connection");
          }
          context.admit("transaction");
          let projectionNeedsReconcile = false;
          const result = applyPreparedTranscriptCommit(input, plan, command.input.messages, () => {
            projectionNeedsReconcile = true;
          });
          context.admit("commit");
          return { result, projectionNeedsReconcile };
        },
        toDatabaseOptions(resolveSqliteTranscriptScope(input.scope)),
        { operationLabel: "worker.transcript.commit" },
      );
    },
    assertSettled() {
      if (context.database.isTransaction) {
        throw new Error("Worker transcript command left a transaction open");
      }
    },
    close() {
      closed = true;
      prepared = undefined;
    },
  };
}
