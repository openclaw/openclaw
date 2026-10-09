import { randomInt } from "node:crypto";
import { setImmediate as yieldToGateway } from "node:timers/promises";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseRuntime,
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "../../state/openclaw-agent-worker-store.js";
import {
  getSessionKysely,
  runExclusiveSqliteSessionWrite,
} from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import { captureIncognitoProjectionBinding } from "./session-incognito-projection.js";
import { drainTranscriptIndexStatus } from "./session-transcript-index-maintenance.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
} from "./session-transcript-index.js";
import type {
  TranscriptProjectionPublicationOperations,
  ProjectionPublisher,
} from "./session-transcript-projection-publication.worker.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  type PreparedSessionTranscriptProjectionMetadata,
} from "./session-transcript-projection-rebuild.js";
import {
  captureMemoryTranscriptProjectionSource,
  type MemoryTranscriptProjectionSource,
} from "./session-transcript-reconcile-memory.js";
import type { EncodedTranscriptFtsChunk } from "./session-transcript-reconcile.worker.js";

const PROJECTION_WRITE_CHUNK_ROWS = 512;
export type ReconcileDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
  assertCurrent?: () => void;
};
export type ActivePreparedProjection = {
  claimId: number;
  plan: PreparedSessionTranscriptProjectionMetadata;
};
type ProjectionStatus = TranscriptProjectionPublicationOperations["preflight"]["output"];
type ProjectionRows = Parameters<
  typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
>[1];
/** Enumerate the admission backlog without waiting for a quiet revision. */
export async function readTranscriptIndexBacklog(
  client: OpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations>,
  assertCurrent: () => void,
  signal: AbortSignal,
): Promise<ProjectionStatus> {
  let traversal: ProjectionStatus["traversal"];
  while (true) {
    assertCurrent();
    const status = await drainTranscriptIndexStatus<ProjectionStatus>(async () => {
      const receipt = await client.executeExisting(
        { type: "preflight", input: undefined },
        assertCurrent,
        { signal },
      );
      return receipt?.value ?? { sessionIds: [], hasMore: false, traversalComplete: true };
    }, traversal);
    assertCurrent();
    traversal = status.traversal;
    if (!status.hasMore || status.traversalComplete) {
      return status;
    }
    await yieldToGateway();
  }
}

export async function runProjectionWrite<T>(
  databaseOptions: ReconcileDatabaseOptions,
  operationLabel: Extract<SqliteSessionWriteOperation, `sessions.transcript-index.${string}`>,
  operation: (database: OpenClawAgentDatabase) => T,
  memorySource?: MemoryTranscriptProjectionSource,
  signal?: AbortSignal,
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
        ? withOpenClawAgentDatabaseRuntime(databaseOptions, write, databaseOptions.assertCurrent)
        : write();
    },
    operationLabel,
    undefined,
    "foreground",
    signal,
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
        scope: "transcript",
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
            scope: "transcript",
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

/** Global readiness is a fact maintained on the projection writer's connection. */
export async function readSessionTranscriptIndexStatus(
  params: OpenClawAgentDatabaseOptions,
  assertCurrent?: () => void,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  assertCurrent?.();
  const options: ReconcileDatabaseOptions = {
    ...params,
    env: { ...(params.env ?? process.env) },
    path: resolveOpenClawAgentSqlitePath(params),
    assertCurrent,
  };
  const incognito = captureIncognitoProjectionBinding(options);
  if (incognito) {
    const pending = await incognito.actor.sessions.withCompute(
      incognito.authority,
      undefined,
      async (compute) => {
        const status = await drainTranscriptIndexStatus(() =>
          compute.execute({ type: "session.compute.store.preflight", input: {} }),
        );
        return status.hasMore || status.sessionIds.length > 0;
      },
      signal,
    );
    incognito.actor.assertReadable();
    incognito.authority.assertCurrent();
    incognito.sharedBinding?.admissionSignal?.throwIfAborted();
    return pending;
  }
  const execution = supportsOpenClawAgentDatabaseExecution(options)
    ? captureOpenClawAgentDatabaseExecution(options)
    : undefined;
  let client: OpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations> | undefined;
  const memorySource = execution ? undefined : captureMemoryTranscriptProjectionSource(options);
  try {
    if (execution) {
      client = await openOpenClawAgentSqliteWorkerStore<TranscriptProjectionPublicationOperations>(
        options,
        { execution },
        {
          moduleUrl: resolveRuntimeWorkerUrl(
            runtimeProcessEntrypoints.sessionTranscriptProjectionPublication,
          ),
          input: undefined,
        },
      );
    }
    const status = client
      ? await drainTranscriptIndexStatus(async () => {
          const receipt = await client!.executeExisting(
            { type: "preflight", input: undefined },
            () => {
              assertCurrent?.();
              execution!.assertCurrent();
            },
            { signal },
          );
          return receipt?.value ?? { sessionIds: [], hasMore: false, traversalComplete: true };
        })
      : await runProjectionWrite(
          options,
          "sessions.transcript-index.preflight",
          (database) => {
            deleteOrphanedTranscriptIndexRowsInTransaction(database.db);
            return {
              sessionIds: listSessionsNeedingTranscriptIndexReconcile(database.db),
              hasMore: false,
            };
          },
          memorySource,
          signal,
        );
    assertCurrent?.();
    return status.hasMore || status.sessionIds.length > 0;
  } finally {
    memorySource?.clear();
    try {
      await client?.close();
    } finally {
      await execution?.release();
    }
  }
}
