import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteWorkerTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import {
  isSessionTranscriptIndexStatusClean,
  maintainSessionTranscriptIndexStatus,
} from "./session-transcript-index-status.worker.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  type PreparedSessionTranscriptProjectionMetadata,
} from "./session-transcript-projection-rebuild.js";

export type TranscriptProjectionRebuildOperations = {
  claim: {
    input: { plan: PreparedSessionTranscriptProjectionMetadata; claimId: number };
    output: boolean;
  };
  deleteChunk: {
    input: Parameters<typeof deletePreparedSessionTranscriptProjectionChunkInTransaction>[1];
    output: ReturnType<typeof deletePreparedSessionTranscriptProjectionChunkInTransaction>;
  };
  appendChunk: {
    input: Parameters<typeof appendPreparedSessionTranscriptProjectionChunkInTransaction>[1];
    output: boolean;
  };
  finalize: {
    input: { plan: PreparedSessionTranscriptProjectionMetadata; claimId: number };
    output: { finalized: boolean; sessionKey?: string };
  };
};

export type TranscriptProjectionPublicationOperations = TranscriptProjectionRebuildOperations & {
  preflight: { input: undefined; output: ReturnType<typeof maintainSessionTranscriptIndexStatus> };
  sweep: { input: undefined; output: ReturnType<typeof maintainSessionTranscriptIndexStatus> };
};

/** The canonical agent executor lends its connection for each bounded publication. */
export function bindSqliteWorkerBackend(_input: undefined, context: SqliteWorkerDatabaseContext) {
  const db = context.database;
  // Incognito rebuild callers expose no global maintenance commands or results.
  function execute(
    command: SqliteWorkerCommand<TranscriptProjectionRebuildOperations>,
  ): TranscriptProjectionRebuildOperations[keyof TranscriptProjectionRebuildOperations]["output"];
  function execute(
    command: SqliteWorkerCommand<TranscriptProjectionPublicationOperations>,
  ): TranscriptProjectionPublicationOperations[keyof TranscriptProjectionPublicationOperations]["output"];
  function execute(command: SqliteWorkerCommand<TranscriptProjectionPublicationOperations>) {
    if (
      (command.type === "preflight" || command.type === "sweep") &&
      isSessionTranscriptIndexStatusClean(db)
    ) {
      return { sessionIds: [], hasMore: false, traversalComplete: true };
    }
    return withSqlitePostCommitPublications(db, () =>
      runSqliteWorkerTransactionSync(
        context,
        () => {
          switch (command.type) {
            case "preflight":
            case "sweep":
              return maintainSessionTranscriptIndexStatus(db);
            case "claim":
              return claimPreparedSessionTranscriptProjectionInTransaction(
                db,
                command.input.plan,
                command.input.claimId,
              );
            case "deleteChunk":
              return deletePreparedSessionTranscriptProjectionChunkInTransaction(db, command.input);
            case "appendChunk":
              return appendPreparedSessionTranscriptProjectionChunkInTransaction(db, command.input);
            case "finalize": {
              const finalized = finalizePreparedSessionTranscriptProjectionInTransaction(
                db,
                command.input.plan,
                command.input.claimId,
              );
              const session = finalized
                ? executeSqliteQueryTakeFirstSync(
                    db,
                    getNodeSqliteKysely<Pick<DB, "session_windows">>(db)
                      .selectFrom("session_windows")
                      .select("session_key")
                      .where("session_id", "=", command.input.plan.sessionId),
                  )
                : undefined;
              return { finalized, ...(session ? { sessionKey: session.session_key } : {}) };
            }
          }
          throw new Error("Unknown transcript projection publication operation");
        },
        {
          operationLabel: `sessions.transcript-index.${command.type}`,
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: context.databasePath,
        },
      ),
    );
  }
  return {
    execute,
    assertSettled() {
      assertTransactionUsable(db);
      if (db.isTransaction) {
        throw new Error("Transcript projection publication did not settle");
      }
    },
    close() {},
  } satisfies SqliteWorkerBackend<TranscriptProjectionPublicationOperations>;
}
