// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { sql } from "kysely";
import { admitStoreSearch } from "../../infra/database-engine/adapters.js";
import { DatabaseSearchCapabilityUnavailableError } from "../../infra/database-engine/capability-unavailable.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { agentTranscriptSearchSchema } from "../../state/openclaw-agent-search-schema.js";
import {
  captureLifecycleDatabaseScope,
  prepareSqliteScope,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { withSessionActorStorage } from "./session-actor-storage-acquisition.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readSessionTranscriptIndexStatus } from "./session-transcript-projection-writer.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import {
  boundSessionTranscriptSearchSnippet,
  sessionTranscriptSearchFtsQuery,
  sessionTranscriptSearchLimit,
  validateSessionTranscriptSearchQuery,
} from "./session-transcript-search-policy.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchReadResult,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";
import { transcriptSearchLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

/** Search committed memory facts or the durable worker; reconciliation remains host-owned. */
export async function searchSessionTranscripts(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: { agentId: string; path: string },
): Promise<SessionTranscriptSearchResult> {
  validateSessionTranscriptSearchQuery(params.query);
  const memory = captureSessionActorStorageOwner(
    {
      ...params,
      storePath: preparedDatabase?.path ?? params.storePath,
    },
    { assertCurrent() {}, authorize() {} },
  );
  if (memory) {
    const query = { type: "session.history.search" as const, input: structuredClone(params) };
    if (memory.binding?.agentId === memory.agentId && memory.binding.path === memory.path) {
      return memory.binding.actor.storage!.read(query, memory.authority);
    }
    const sessionKey = memory.owner?.listSessions(memory.authority)[0]?.target.sessionKey;
    if (sessionKey) {
      const result = await withSessionActorStorage(
        { agentId: memory.agentId, storePath: memory.path, sessionKey, env: params.env },
        {
          authority: memory.authority,
          lifetime: {
            assertCurrent: () => memory.authority.assertCurrent(),
            assertReadable: () => memory.authority.assertCurrent(),
          },
        },
        (binding) => binding.actor.storage.read(query, binding.authority),
      );
      if (result) {
        return result;
      }
    }
    return { hits: [], indexing: false, truncated: false };
  }
  const scope = captureLifecycleDatabaseScope(
    preparedDatabase
      ? {
          agentId: params.agentId,
          databaseAgentId: preparedDatabase.agentId,
          path: preparedDatabase.path,
          env: params.env,
        }
      : await prepareSqliteScope({ ...params, sessionKey: params.sessionKey ?? "" }),
  );
  const options = toDatabaseOptions(scope);
  const request = {
    ...params,
    agentId: scope.agentId,
    env: scope.env,
    sessionKeys: params.sessionKeys?.slice(),
  };
  let statusOwnerFailure: { error: unknown } | undefined;
  const readIndexStatus = async (
    assertCurrent?: () => void,
    signal?: AbortSignal,
  ): Promise<boolean> => {
    signal?.throwIfAborted();
    assertCurrent?.();
    let indexing: boolean;
    try {
      if (statusOwnerFailure) {
        throw statusOwnerFailure.error;
      }
      indexing = await readSessionTranscriptIndexStatus(options, assertCurrent, signal);
    } catch {
      // Writable maintenance failure must not discard an authorized read-only result.
      signal?.throwIfAborted();
      assertCurrent?.();
      return true;
    }
    signal?.throwIfAborted();
    assertCurrent?.();
    if (indexing) {
      startSessionTranscriptIndexReconcile(options);
    }
    return indexing;
  };
  let execution: OpenClawAgentDatabaseExecution | undefined;
  try {
    try {
      // Retain writer admission while the search checks projection readiness.
      if (supportsOpenClawAgentDatabaseExecution(options)) {
        execution = captureOpenClawAgentDatabaseExecution(options);
      }
    } catch (error) {
      statusOwnerFailure = { error };
    }
    return await withSessionHistoryWorkerDatabase(
      options,
      async (owner) => {
        const result = await owner.searchTranscripts(request, (signal) =>
          readIndexStatus(owner.assertCurrent, signal),
        );
        owner.assertCurrent();
        return {
          ...result,
          indexing: result.indexing || isSessionTranscriptIndexReconcileRunning(options),
        };
      },
      transcriptSearchLane,
    );
  } catch (error) {
    if (error instanceof WorkerTaskError && error.code === "timeout") {
      throw new WorkerTaskError(
        "Session transcript search timed out; narrow the session selection or use more specific query keywords, then retry. A timeout does not mean that no matching conversation exists.",
        "timeout",
        { cause: error },
      );
    }
    throw error;
  } finally {
    await execution?.release();
  }
}

/** Native query kernel; projection readiness belongs to the maintenance owner. */
export function searchSessionTranscriptsReadOnlySync(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: OpenClawAgentDatabaseOptions,
): SessionTranscriptSearchReadResult {
  const query = validateSessionTranscriptSearchQuery(params.query);
  const scope = preparedDatabase ? { agentId: params.agentId } : resolveSqliteReadScope(params);
  const databaseOptions = preparedDatabase ?? toDatabaseOptions(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => ({
      ...runSqliteReadSnapshotSync(
        database.db,
        () => {
          const limit = sessionTranscriptSearchLimit(params.limit);
          // Shared databases hold multiple logical agents. Filter before LIMIT;
          // reserved global/unknown sentinels retain their store-wide scope.
          const db = getNodeSqliteKysely<DB>(database.db);
          const search = admitStoreSearch(database.db, agentTranscriptSearchSchema);
          if (!search.fullText) {
            throw new DatabaseSearchCapabilityUnavailableError(
              "fullText",
              search.diagnostics.join("; "),
            );
          }
          const textIndex = search.text.transcript!;
          const literalQuery = sessionTranscriptSearchFtsQuery(query, params.match);
          const ranking = search.fullText.rank(textIndex, literalQuery);
          const agentPrefix = toAgentStoreSessionKey({
            agentId: scope.agentId,
            requestKey: "*",
          }).slice(0, -1);
          const selectedWindows = db
            .selectFrom("session_windows")
            .select(["session_id", "session_key"])
            .where((eb) =>
              params.sessionKeys === undefined
                ? eb.or([
                    isPostgresSqlConnection(database.db)
                      ? /* kysely-allow-raw: starts_with keeps underscores literal and, unlike left(), has planner selectivity, so the GIN match can drive the join. */ sql<boolean>`${eb.ref("session_key")} ^@ ${agentPrefix}`
                      : /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */ sql<boolean>`${eb.ref("session_key")} GLOB ${toAgentStoreSessionKey({ agentId: scope.agentId, requestKey: "*" })}`,
                    eb("session_key", "in", ["global", "unknown"]),
                  ])
                : params.sessionKeys.length > 0
                  ? eb("session_key", "in", sqliteStringSet(params.sessionKeys))
                  : eb.and([]),
            )
            .$if(params.sessionId !== undefined, (builder) =>
              builder.where("session_id", "=", params.sessionId!),
            );
          const archivedTranscriptsExcluded =
            executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("session_transcript_cold_archives as cold")
                .innerJoin(selectedWindows.as("window"), "window.session_id", "cold.session_id")
                .select((eb) => eb.fn.countAll<number>().as("count")),
            )?.count ?? 0;
          const match = search.fullText.match(textIndex, literalQuery);
          const order =
            params.order === "recent"
              ? sql`session_transcript_fts.timestamp desc, fts_rowid desc`
              : sql`rank ${/* kysely-allow-raw: Capability order is the closed asc/desc union. */ sql.raw(ranking.order)}, session_transcript_fts.timestamp desc, session_transcript_fts.message_id asc`;
          // session_key lives on the window row so key renames
          // never leave stale keys inside the index. Sessions flagged needs_rebuild
          // are excluded: their rows may still hold rewound-away branch text that
          // sessions_history no longer exposes, so they stay hidden until reconcile
          // rebuilds them (indexing=true tells the caller to retry).
          const candidates = db
            .selectFrom("session_transcript_fts")
            // Keep MATCH outermost; the narrow map rejects excluded content before hydration.
            .crossJoin("session_transcript_fts_rows as mapped")
            .crossJoin(selectedWindows.as("window"))
            .where("mapped.id", "=", search.fullText.identity(textIndex))
            .whereRef("window.session_id", "=", "mapped.session_id")
            .where(match)
            // Depend on the scoped window so SQLite cannot read role before excluding sessions.
            .$if(Boolean(params.role), (builder) =>
              isPostgresSqlConnection(database.db)
                ? builder.where("role", "=", params.role!)
                : builder.where((eb) =>
                    eb
                      .case()
                      .when("window.session_key", "is not", null)
                      .then(eb("role", "=", params.role!))
                      .else(false)
                      .end(),
                  ),
            )
            .where(
              "mapped.session_id",
              "not in",
              db
                .selectFrom("session_transcript_index_state")
                .select("session_id")
                .where("needs_rebuild", "!=", 0),
            )
            .select([
              "window.session_key",
              search.fullText.identity(textIndex).as("fts_rowid"),
              ranking.value.as("rank"),
            ]);
          const selectedHits =
            params.order === "recent"
              ? candidates.orderBy(order).limit(limit + 1)
              : db
                  .with(
                    (cte) => cte("scores").materialized(),
                    () => candidates,
                  )
                  .selectFrom("scores")
                  .crossJoin("session_transcript_fts")
                  .where((eb) =>
                    eb(search.fullText!.identity(textIndex), "=", eb.ref("scores.fts_rowid")),
                  )
                  // Keep every tie at the cutoff before reading metadata for the final ordering.
                  .where("scores.rank", "in", (eb) =>
                    eb
                      .selectFrom("scores")
                      .select("rank")
                      .orderBy("rank", ranking.order)
                      .limit(limit + 1),
                  )
                  .select(["scores.session_key", "scores.fts_rowid", "scores.rank"])
                  .orderBy("scores.rank", ranking.order)
                  .orderBy("session_transcript_fts.timestamp", "desc")
                  .orderBy("session_transcript_fts.message_id", "asc")
                  .limit(limit + 1);
          const rows = executeSqliteQuerySync(
            database.db,
            db
              .with(
                (cte) => cte("hits").materialized(),
                () => selectedHits,
              )
              .selectFrom("hits")
              .crossJoin("session_transcript_fts")
              .where((eb) =>
                eb(search.fullText!.identity(textIndex), "=", eb.ref("hits.fts_rowid")),
              )
              .where(match)
              .select([
                "hits.session_key",
                "session_transcript_fts.session_id",
                "message_id",
                "role",
                "timestamp",
                "hits.rank as rank",
                search.fullText.snippet(textIndex, "text", 48, literalQuery).as("snippet"),
              ])
              .orderBy(order),
          ).rows;
          const hits = rows.flatMap((row): SessionTranscriptSearchResult["hits"] => {
            if (
              typeof row.session_key !== "string" ||
              typeof row.session_id !== "string" ||
              typeof row.message_id !== "string" ||
              (row.role !== "user" && row.role !== "assistant") ||
              typeof row.snippet !== "string"
            ) {
              return [];
            }
            const timestamp =
              typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
            const rank = typeof row.rank === "number" ? row.rank : Number(row.rank);
            return [
              {
                sessionKey: row.session_key,
                sessionId: row.session_id,
                messageId: row.message_id,
                role: row.role,
                timestamp: Number.isFinite(timestamp) ? timestamp : 0,
                snippet: boundSessionTranscriptSearchSnippet(row.snippet),
                score: ranking.toRank(rank),
              },
            ];
          });
          return {
            found: true,
            hits: hits.slice(0, limit),
            truncated: hits.length > limit,
            ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
          };
        },
        { databaseLabel: database.path, operationLabel: "session transcript search" },
      ),
    }),
    databaseOptions,
  );
  return result.found ? result.value : { found: false, hits: [], truncated: false };
}
