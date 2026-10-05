import {
  readSessionCostUsageRefreshLockInDatabase,
  readSessionCostUsageRollupBodyInDatabase,
  readSessionCostUsageRollupByteRowsInDatabase,
} from "../../infra/session-cost-usage-cache.kernel.js";
import { withSqlitePostCommitPublications } from "../../infra/sqlite-post-commit.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { loadUsageCacheOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { AgentWorkerOperationContext } from "../../state/openclaw-agent-operation-context.js";
import { createWorkerOperationRegistry } from "../../state/worker-operation-registry.js";
import {
  parseSqliteSessionFileMarker,
  sqliteSessionFileMarkerMatchesTarget,
} from "./legacy-sqlite-marker.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import { listTranscriptInstancesFromDatabase } from "./session-accessor.sqlite-history.js";
import { readTranscriptStatsFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import {
  isIncognitoStoreComputeCommand,
  type IncognitoComputeInstance,
  type IncognitoStoreComputeOperations,
  type IncognitoComputeOperations,
  type IncognitoComputeTarget,
  type IncognitoUsageCacheOperations,
} from "./session-incognito-compute-contract.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";
import { deletePreparedSessionTranscriptProjectionChunkInTransaction } from "./session-transcript-projection-rebuild.js";
import {
  createMemoryTranscriptProjectionSource,
  type MemoryTranscriptProjectionSource,
} from "./session-transcript-reconcile-memory.js";

type Command = SqliteWorkerCommand<IncognitoComputeOperations>;
type Source = {
  target: IncognitoComputeTarget;
  source: MemoryTranscriptProjectionSource;
  projection: boolean;
  claimId?: number;
};

/** Sources retain framing state, not a FIFO reservation or an open SQL transaction. */
export function createIncognitoComputeWorker(
  database: OpenClawAgentDatabase,
  env: NodeJS.ProcessEnv,
  admit: (stage: "transaction" | "commit", keys: readonly string[]) => void,
) {
  const sources = new Map<string, Source>();
  let keys: string[] = [];
  const options = { agentId: database.agentId, path: database.path, env };
  let projection:
    | ReturnType<
        typeof import("./session-transcript-projection-publication.worker.js").bindSqliteWorkerBackend
      >
    | undefined;
  const cache = createWorkerOperationRegistry<
    IncognitoUsageCacheOperations,
    AgentWorkerOperationContext
  >({ usageCache: loadUsageCacheOperations });
  const context: AgentWorkerOperationContext = {
    open: () => database,
    options,
    admit: (stage) => admit(stage, keys),
    writeTransaction: (operationLabel, _owner, write) =>
      runOpenClawAgentWriteTransaction(
        (current) => {
          if (current.db !== database.db) {
            throw new Error("Incognito usage cache lost its native owner");
          }
          admit("transaction", keys);
          return write(current);
        },
        options,
        { operationLabel },
      ),
  };
  const sourceFor = (input: IncognitoComputeTarget & { sourceId: string }, rebuild = false) => {
    const held = sources.get(input.sourceId);
    if (
      !held ||
      held.target.sessionKey !== input.sessionKey ||
      held.target.sessionId !== input.sessionId ||
      held.target.lifecycleRevision !== input.lifecycleRevision
    ) {
      throw new Error("Incognito compute source belongs to another session generation");
    }
    if (rebuild && !held.projection) {
      throw new Error("A bounded usage source cannot publish a transcript projection");
    }
    return held;
  };
  const assertCacheKey = (key: string, input: IncognitoComputeTarget) => {
    if (
      !sqliteSessionFileMarkerMatchesTarget(key, {
        agentId: database.agentId,
        sessionId: input.sessionId,
        storePath: database.path,
      })
    ) {
      throw new Error("Incognito usage cache row belongs to another transcript");
    }
  };
  const inventory = (includeAllWindows = false): IncognitoComputeInstance[] =>
    listTranscriptInstancesFromDatabase({
      database,
      currentEntries: { get: (key) => readExactSessionEntryRow(database, key, "list")?.entry },
      options: { includeAllWindows },
    }).map(({ sessionKey, sessionId, updatedAtMs }) => {
      const current = readExactSessionEntryRow(database, sessionKey, "list")?.entry;
      return {
        sessionKey,
        sessionId,
        lifecycleRevision: current?.lifecycleRevision,
        historical: current?.sessionId !== sessionId,
        updatedAtMs,
      };
    });
  const executeStore = (command: SqliteWorkerCommand<IncognitoStoreComputeOperations>) => {
    const instances = inventory(true);
    keys = [...new Set(instances.map((entry) => entry.sessionKey))];
    const assertStoreCacheKey = (key: string) => {
      const marker = parseSqliteSessionFileMarker(key);
      if (
        !marker ||
        !sqliteSessionFileMarkerMatchesTarget(key, {
          agentId: database.agentId,
          storePath: database.path,
          sessionId: marker.sessionId,
        })
      ) {
        throw new Error("Incognito usage cache row belongs to another transcript");
      }
    };
    switch (command.type) {
      case "session.compute.store.status":
        return sessionTranscriptIndexNeedsReconcile(database.db, command.input.sessionId);
      case "session.compute.store.inventory":
        return inventory();
      case "session.compute.store.preflight":
      case "session.compute.store.sweep":
        return context.writeTransaction(
          "sessions.transcript-index.preflight",
          "Incognito store projection",
          () => {
            deleteOrphanedTranscriptIndexRowsInTransaction(database.db);
            const pending = new Set(listSessionsNeedingTranscriptIndexReconcile(database.db));
            admit("commit", keys);
            return command.type === "session.compute.store.sweep"
              ? null
              : inventory(true).filter((entry) => pending.has(entry.sessionId));
          },
        );
      case "session.compute.store.refreshLock":
        return readSessionCostUsageRefreshLockInDatabase(database.db);
      case "session.compute.store.cache":
        command.input.request.filePaths.forEach(assertStoreCacheKey);
        return readSessionCostUsageRollupByteRowsInDatabase(
          database.db,
          command.input.request.filePaths,
        );
      case "session.compute.store.cacheBody": {
        assertStoreCacheKey(command.input.request.key);
        const row = readSessionCostUsageRollupBodyInDatabase(database.db, command.input.request);
        return row ? { blob: row.blob ? Uint8Array.from(row.blob) : null } : undefined;
      }
      case "session.compute.store.writeRollup":
        assertStoreCacheKey(command.input.request.rollupId);
        return cache.execute(
          { type: "usageCache.writeRollup", input: command.input.request },
          context,
        );
      case "session.compute.store.prune":
        command.input.request.forEach((row) => assertStoreCacheKey(row.key));
        return cache.execute({ type: "usageCache.prune", input: command.input.request }, context);
      case "session.compute.store.acquireLock":
        return cache.execute(
          { type: "usageCache.acquireLock", input: command.input.request },
          context,
        );
      case "session.compute.store.releaseLock":
        return cache.execute(
          { type: "usageCache.releaseLock", input: command.input.request },
          context,
        );
    }
  };
  return {
    async prepare(command: Command) {
      if (command.type.startsWith("session.compute.projection.") && !projection) {
        const { bindSqliteWorkerBackend } =
          await import("./session-transcript-projection-publication.worker.js");
        projection = bindSqliteWorkerBackend(undefined, {
          databasePath: database.path,
          database: database.db,
          admit: (stage) => admit(stage, keys),
        });
      } else if (
        command.type.startsWith("session.compute.usage.") ||
        isIncognitoStoreComputeCommand(command)
      ) {
        await cache.prepare(
          command.type.replace(/^session\.compute\.(usage|store)\./, "usageCache."),
        );
      }
    },
    execute(command: Command) {
      if (isIncognitoStoreComputeCommand(command)) {
        const value = executeStore(command);
        return { value, keys };
      }
      const input = command.input;
      keys = [input.sessionKey];
      const executeProjection = (
        inner: SqliteWorkerCommand<TranscriptProjectionPublicationOperations>,
      ) => {
        if (!projection) {
          throw new Error("Incognito projection domain was not prepared");
        }
        return projection.execute(inner);
      };
      try {
        // Exact source cleanup remains possible after its session was deleted.
        if (command.type === "session.compute.source.release") {
          const held = sources.get(command.input.sourceId);
          const value = context.writeTransaction(
            "sessions.transcript-index.delete-chunk",
            "Incognito source cleanup",
            () => {
              if (held) {
                sourceFor(command.input);
              }
              const more =
                held?.claimId !== undefined &&
                deletePreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
                  sessionId: input.sessionId,
                  claimId: held.claimId,
                  maxRowsPerTable: 512,
                }).hasMore;
              admit("commit", keys);
              return more;
            },
          );
          if (!value) {
            held?.source.clear();
            sources.delete(command.input.sourceId);
          }
          return { value, keys };
        }
        if (command.type === "session.compute.usage.releaseLock") {
          return {
            value: cache.execute(
              { type: "usageCache.releaseLock", input: command.input.request },
              context,
            ),
            keys,
          };
        }
        const entry = readExactSessionEntryRow(database, input.sessionKey)?.entry;
        if (
          entry?.lifecycleRevision !== input.lifecycleRevision ||
          (input.historical
            ? !inventory(true).some(
                (row) => row.sessionKey === input.sessionKey && row.sessionId === input.sessionId,
              )
            : !entry || entry.sessionId !== input.sessionId)
        ) {
          throw new Error("Incognito compute session generation is no longer current");
        }
        const value = withSqlitePostCommitPublications(database.db, () => {
          switch (command.type) {
            case "session.compute.status":
              return sessionTranscriptIndexNeedsReconcile(database.db, input.sessionId);
            case "session.compute.source.open": {
              if (sources.has(command.input.sourceId)) {
                throw new Error("Incognito compute source is already open");
              }
              sources.set(command.input.sourceId, {
                target: {
                  sessionKey: input.sessionKey,
                  sessionId: input.sessionId,
                  lifecycleRevision: input.lifecycleRevision,
                },
                projection: command.input.range === undefined,
                source: createMemoryTranscriptProjectionSource(
                  database,
                  options,
                  command.input.range,
                ),
              });
              return;
            }
            case "session.compute.source.read":
              return sourceFor(command.input).source.read(input.sessionId);
            case "session.compute.usage.stats":
              return readTranscriptStatsFromDatabase(database, input.sessionId);
            case "session.compute.usage.cache":
              command.input.request.filePaths.forEach((key) => assertCacheKey(key, input));
              return readSessionCostUsageRollupByteRowsInDatabase(
                database.db,
                command.input.request.filePaths,
              );
            case "session.compute.usage.cacheBody": {
              assertCacheKey(command.input.request.key, input);
              const row = readSessionCostUsageRollupBodyInDatabase(
                database.db,
                command.input.request,
              );
              return row ? { blob: row.blob ? Uint8Array.from(row.blob) : null } : undefined;
            }
            case "session.compute.usage.refreshLock":
              return readSessionCostUsageRefreshLockInDatabase(database.db);
            case "session.compute.usage.writeRollup":
              assertCacheKey(command.input.request.rollupId, input);
              return cache.execute(
                { type: "usageCache.writeRollup", input: command.input.request },
                context,
              );
            case "session.compute.usage.prune":
              command.input.request.forEach((row) => assertCacheKey(row.key, input));
              return cache.execute(
                { type: "usageCache.prune", input: command.input.request },
                context,
              );
            case "session.compute.usage.acquireLock":
              return cache.execute(
                { type: "usageCache.acquireLock", input: command.input.request },
                context,
              );
            case "session.compute.projection.claim":
            case "session.compute.projection.finalize": {
              const { request } = command.input;
              if (request.plan.sessionId !== input.sessionId) {
                throw new Error("Incognito projection plan belongs to another transcript");
              }
              const held = sourceFor(command.input, true);
              if (!held.source.isCurrentPlan(request.plan)) {
                // A stale source is the existing no-write result, with a confirmed receipt.
                return context.writeTransaction(
                  command.type === "session.compute.projection.claim"
                    ? "sessions.transcript-index.claim"
                    : "sessions.transcript-index.finalize",
                  "Incognito projection",
                  () => {
                    admit("commit", keys);
                    return command.type === "session.compute.projection.claim"
                      ? false
                      : { finalized: false };
                  },
                );
              }
              if (command.type === "session.compute.projection.claim") {
                const claimed = executeProjection({ type: "claim", input: request });
                if (claimed) {
                  held.claimId = request.claimId;
                }
                return claimed;
              }
              if (held.claimId !== request.claimId) {
                throw new Error("Incognito projection claim belongs to another source");
              }
              return executeProjection({ type: "finalize", input: request });
            }
            case "session.compute.projection.deleteChunk":
            case "session.compute.projection.appendChunk": {
              const { request } = command.input;
              if (
                sourceFor(command.input, true).claimId !== request.claimId ||
                request.sessionId !== input.sessionId
              ) {
                throw new Error("Incognito projection chunk belongs to another transcript");
              }
              return command.type === "session.compute.projection.deleteChunk"
                ? executeProjection({ type: "deleteChunk", input: command.input.request })
                : executeProjection({ type: "appendChunk", input: command.input.request });
            }
          }
          throw new Error("Unsupported incognito compute operation");
        });
        return { value, keys };
      } finally {
        projection?.assertSettled();
      }
    },
    assertSettled() {
      projection?.assertSettled();
    },
    close() {
      for (const { source } of sources.values()) {
        source.clear();
      }
      sources.clear();
      projection?.close();
    },
  };
}
