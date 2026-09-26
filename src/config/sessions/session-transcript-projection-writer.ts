import { randomInt } from "node:crypto";
import { setImmediate as yieldToGateway } from "node:timers/promises";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  type PreparedSessionTranscriptProjectionMetadata,
} from "./session-transcript-projection-rebuild.js";
import type { MemoryTranscriptProjectionSource } from "./session-transcript-reconcile-memory.js";

const PROJECTION_WRITE_CHUNK_ROWS = 512;
export type ReconcileDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
};
export type ProjectionPublisher = Pick<
  SqliteWorkerStore<TranscriptProjectionPublicationOperations>,
  "execute"
>;
export type ActivePreparedProjection = {
  claimId: number;
  plan: PreparedSessionTranscriptProjectionMetadata;
};
function nextProjectionClaimId(): number {
  return -randomInt(1, 2 ** 47);
}

export async function runProjectionWrite<T>(
  databaseOptions: ReconcileDatabaseOptions,
  operationLabel: Extract<SqliteSessionWriteOperation, `sessions.transcript-index.${string}`>,
  operation: (database: OpenClawAgentDatabase) => T,
  memorySource?: MemoryTranscriptProjectionSource,
): Promise<T> {
  return await runExclusiveSqliteSessionWrite(
    databaseOptions,
    async () => {
      const write = () => {
        // Disposal revokes a memory source. Check inside the queue before the opener
        // can materialize a successor database for a late worker result.
        memorySource?.assertCurrentOwner();
        return runOpenClawAgentWriteTransaction(operation, databaseOptions, { operationLabel });
      };
      return !isIncognitoOpenClawAgentSqlitePath(databaseOptions.path, databaseOptions) &&
        !getOpenClawAgentDatabaseIfOpen(databaseOptions)
        ? withOpenClawAgentDatabaseAsync(databaseOptions, write)
        : write();
    },
    operationLabel,
  );
}

export async function claimPreparedSessionTranscriptProjection(
  databaseOptions: ReconcileDatabaseOptions,
  plan: PreparedSessionTranscriptProjectionMetadata,
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<ActivePreparedProjection | undefined> {
  const claimId = nextProjectionClaimId();
  const claimed = publication
    ? await publication.execute({ type: "claim", input: { plan, claimId } })
    : await runProjectionWrite(
        databaseOptions,
        "sessions.transcript-index.claim",
        (database) =>
          (!memorySource || memorySource.isCurrentPlan(plan)) &&
          claimPreparedSessionTranscriptProjectionInTransaction(database.db, plan, claimId),
        memorySource,
      );
  if (!claimed) {
    return undefined;
  }

  let deleteResult = { hasMore: true, owned: true };
  while (deleteResult.hasMore && deleteResult.owned) {
    deleteResult = publication
      ? await publication.execute({
          type: "deleteChunk",
          input: {
            maxRowsPerTable: PROJECTION_WRITE_CHUNK_ROWS,
            sessionId: plan.sessionId,
            claimId,
          },
        })
      : await runProjectionWrite(
          databaseOptions,
          "sessions.transcript-index.delete-chunk",
          (database) =>
            deletePreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
              maxRowsPerTable: PROJECTION_WRITE_CHUNK_ROWS,
              sessionId: plan.sessionId,
              claimId,
            }),
          memorySource,
        );
    await yieldToGateway();
  }
  if (!deleteResult.owned) {
    return undefined;
  }
  return { claimId, plan };
}

export async function appendPreparedProjectionChunk(
  databaseOptions: ReconcileDatabaseOptions,
  active: ActivePreparedProjection,
  rows:
    | {
        activeRows: Parameters<
          typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
        >[1]["activeRows"];
      }
    | {
        ftsRows: Parameters<
          typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
        >[1]["ftsRows"];
      },
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<boolean> {
  const owned = publication
    ? await publication.execute({
        type: "appendChunk",
        input: {
          ...rows,
          claimId: active.claimId,
          sessionId: active.plan.sessionId,
        },
      })
    : await runProjectionWrite(
        databaseOptions,
        "activeRows" in rows
          ? "sessions.transcript-index.active-chunk"
          : "sessions.transcript-index.fts-chunk",
        (database) =>
          appendPreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
            ...rows,
            claimId: active.claimId,
            sessionId: active.plan.sessionId,
          }),
        memorySource,
      );
  await yieldToGateway();
  return owned;
}

export async function finalizePreparedProjection(
  databaseOptions: ReconcileDatabaseOptions,
  active: ActivePreparedProjection,
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<boolean> {
  if (publication) {
    const result = await publication.execute({ type: "finalize", input: active });
    if (result.sessionKey !== undefined) {
      sessionChanges.emit({
        storePath: databaseOptions.path,
        sessionKey: result.sessionKey,
        facts: { kind: "unchanged" },
      });
    }
    return result.finalized;
  }
  return await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.finalize",
    (database) => {
      const finalized =
        (!memorySource || memorySource.isCurrentPlan(active.plan)) &&
        finalizePreparedSessionTranscriptProjectionInTransaction(
          database.db,
          active.plan,
          active.claimId,
        );
      const session =
        finalized &&
        executeSqliteQueryTakeFirstSync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("session_windows")
            .select("session_key")
            .where("session_id", "=", active.plan.sessionId),
        );
      if (session) {
        sessionChanges.emit(
          {
            storePath: database.path,
            sessionKey: session.session_key,
            facts: { kind: "unchanged" },
          },
          database.db,
        );
      }
      return finalized;
    },
    memorySource,
  );
}
