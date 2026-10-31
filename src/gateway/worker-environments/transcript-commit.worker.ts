import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "../../infra/sqlite-worker-binding.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import type { PreparedTranscriptCommit } from "./transcript-commit-policy.js";
import {
  applyPreparedTranscriptCommit,
  prepareTranscriptCommit,
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
    output: {
      result: ApplyTranscriptCommitResult;
      projectionNeedsReconcile: boolean;
      entry?: SessionEntry;
    };
  };
};

/** The canonical agent actor owns the connection and writer admission. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: SqliteWorkerDatabaseContext,
): SqliteWorkerBackend<WorkerTranscriptOperations> {
  let prepared: { input: TranscriptCommitInput; plan: PreparedTranscriptCommit } | undefined;
  return bindSqliteWorkerDatabase<WorkerTranscriptOperations>(context.database, {
    execute(command) {
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
        const plan = runSqliteReadSnapshotSync(context.database, () =>
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
          let entry: SessionEntry | undefined;
          const result = applyPreparedTranscriptCommit(
            input,
            plan,
            command.input.messages,
            () => {
              projectionNeedsReconcile = true;
            },
            (updatedEntry) => {
              entry = updatedEntry;
            },
          );
          context.admit("commit");
          return { result, projectionNeedsReconcile, entry };
        },
        toDatabaseOptions(resolveSqliteTranscriptScope(input.scope)),
        { operationLabel: "worker.transcript.commit" },
      );
    },
    close() {
      prepared = undefined;
    },
  });
}
