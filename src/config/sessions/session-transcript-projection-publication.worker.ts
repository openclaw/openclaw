import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { runWithSqliteBusyTimeout } from "../../infra/sqlite-busy-timeout.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
  runSqliteWorkerTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import type { SqliteWorkerDatabaseContext } from "../../infra/sqlite-worker-database-context.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../../state/openclaw-state-db-contract.js";
import {
  publishUnchangedSessionTranscriptAuthority,
  readStagedSessionTranscriptAuthority,
  type SessionTranscriptAuthorityReceipt,
} from "./session-transcript-authority.js";
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
    output: {
      finalized: boolean;
      sessionKey?: string;
      transcriptPublication?: readonly SessionTranscriptAuthorityReceipt[];
    };
  };
};

export type TranscriptProjectionPublicationOperations = TranscriptProjectionRebuildOperations & {
  preflight: { input: undefined; output: ReturnType<typeof maintainSessionTranscriptIndexStatus> };
  sweep: { input: undefined; output: ReturnType<typeof maintainSessionTranscriptIndexStatus> };
};

export type ProjectionPublisher = Pick<
  SqliteWorkerStore<TranscriptProjectionRebuildOperations>,
  "execute"
>;

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
  function execute(
    command: SqliteWorkerCommand<TranscriptProjectionPublicationOperations>,
  ): TranscriptProjectionPublicationOperations[keyof TranscriptProjectionPublicationOperations]["output"] {
    if (command.type === "preflight" || command.type === "sweep") {
      if (isSessionTranscriptIndexStatusClean(db)) {
        return { sessionIds: [], hasMore: false, traversalComplete: true };
      }
      // Derived maintenance has no prepared row or publication facts. Admit the whole
      // bounded effect, then reread rows without waiting for the host under a write lock.
      context.admit("transaction");
      context.admit("commit");
      let entered = false;
      try {
        return runWithSqliteBusyTimeout(db, 0, () =>
          runSqliteImmediateTransactionSync(
            db,
            () => {
              entered = true;
              return maintainSessionTranscriptIndexStatus(db);
            },
            {
              operationLabel: `sessions.transcript-index.${command.type}`,
              beginLockFailureReporting: "suppress",
            },
          ),
        );
      } catch (error) {
        if (entered || !isSqliteLockError(error)) {
          throw error;
        }
        // The existing drain yields and obtains fresh grants on its next attempt.
        return { sessionIds: [], hasMore: true, traversalComplete: false };
      }
    }
    return withSqlitePostCommitPublications(db, () =>
      runSqliteWorkerTransactionSync(
        context,
        () => {
          switch (command.type) {
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
              if (session) {
                publishUnchangedSessionTranscriptAuthority(
                  { db, path: context.databasePath },
                  session.session_key,
                );
              }
              return {
                finalized,
                ...(session ? { sessionKey: session.session_key } : {}),
                transcriptPublication: readStagedSessionTranscriptAuthority({ db }),
              };
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
