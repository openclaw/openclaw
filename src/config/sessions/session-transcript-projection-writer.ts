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
import type { EncodedTranscriptFtsChunk } from "./session-transcript-reconcile.worker.js";

const PROJECTION_WRITE_CHUNK_ROWS = 512;
export type ReconcileDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
  assertCurrent?: () => void;
};
export type ProjectionPublisher = Pick<
  SqliteWorkerStore<TranscriptProjectionPublicationOperations>,
  "execute"
>;
export type ActivePreparedProjection = {
  claimId: number;
  plan: PreparedSessionTranscriptProjectionMetadata;
};
type ProjectionRows = Parameters<
  typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
>[1];
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
        databaseOptions.assertCurrent?.();
        return runOpenClawAgentWriteTransaction(
          (database) => {
            databaseOptions.assertCurrent?.();
            const result = operation(database);
            databaseOptions.assertCurrent?.();
            return result;
          },
          databaseOptions,
          { operationLabel },
        );
      };
      return !isIncognitoOpenClawAgentSqlitePath(databaseOptions.path, databaseOptions) &&
        !getOpenClawAgentDatabaseIfOpen(databaseOptions)
        ? withOpenClawAgentDatabaseAsync(databaseOptions, write, databaseOptions.assertCurrent)
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
  const claimId = -randomInt(1, 2 ** 47);
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
    const input = {
      maxRowsPerTable: PROJECTION_WRITE_CHUNK_ROWS,
      sessionId: plan.sessionId,
      claimId,
    };
    deleteResult = publication
      ? await publication.execute({ type: "deleteChunk", input })
      : await runProjectionWrite(
          databaseOptions,
          "sessions.transcript-index.delete-chunk",
          (database) =>
            deletePreparedSessionTranscriptProjectionChunkInTransaction(database.db, input),
          memorySource,
        );
    await yieldToGateway();
  }
  if (!deleteResult.owned) {
    return undefined;
  }
  return { claimId, plan };
}

function decodeFtsChunk(chunk: EncodedTranscriptFtsChunk) {
  const decoder = new TextDecoder();
  return chunk.rows.map((row) => ({
    messageId: row.messageId,
    role: row.role,
    text: decoder.decode(
      chunk.textBytes.subarray(row.textByteOffset, row.textByteOffset + row.textByteLength),
    ),
    timestamp: row.timestamp,
  }));
}

export async function appendPreparedProjectionChunk(
  databaseOptions: ReconcileDatabaseOptions,
  active: ActivePreparedProjection,
  rows: { activeRows: ProjectionRows["activeRows"] } | { ftsChunk: EncodedTranscriptFtsChunk },
  memorySource?: MemoryTranscriptProjectionSource,
  publication?: ProjectionPublisher,
): Promise<boolean> {
  const input = {
    ...("activeRows" in rows ? rows : { ftsRows: decodeFtsChunk(rows.ftsChunk) }),
    claimId: active.claimId,
    sessionId: active.plan.sessionId,
  };
  const owned = publication
    ? await publication.execute({ type: "appendChunk", input })
    : await runProjectionWrite(
        databaseOptions,
        "activeRows" in rows
          ? "sessions.transcript-index.active-chunk"
          : "sessions.transcript-index.fts-chunk",
        (database) =>
          appendPreparedSessionTranscriptProjectionChunkInTransaction(database.db, input),
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
