// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { expressionBuilder, sql, type RawBuilder, type QueryResult } from "kysely";
import { admitStoreSearch } from "../../infra/database-engine/adapters.js";
import { DatabaseSearchCapabilityUnavailableError } from "../../infra/database-engine/capability-unavailable.js";
import { engineStringPosition } from "../../infra/database-engine/scalar.js";
import {
  bindSqliteFullText,
  sqliteFullTextLiteralQuery,
} from "../../infra/database-engine/sqlite-full-text.js";
import { hasFullTextWordTokens } from "../../infra/database-engine/text-tokens.worker.js";
import {
  createSqliteQueryCache,
  prepareSqliteQuerySync,
  prepareSqliteQueryTakeFirstSync,
  encodeSqliteStringSet,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteEncodedStringSet,
  sqliteStringSetEntries,
} from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { sqliteStringSetFragments } from "../../infra/sql-query-compiler.js";
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
  SessionTranscriptSearchKeySet,
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
    storePath: options.path,
    env: scope.env,
    sessionKeys: params.sessionKeys,
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

type PaletteSearchBindings = { keys: string; match: string; limit: number };
const paletteSearchQueries = createSqliteQueryCache<{
  cold?: (keys: string) => { count: number } | undefined;
  hits?: (params: PaletteSearchBindings) => QueryResult<{
    session_key: string;
    fts_rowid: number;
    rank: number;
  }>;
}>(() => ({}));

/** Native query kernel; projection readiness belongs to the maintenance owner. */
export function searchSessionTranscriptsReadOnlySync(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: OpenClawAgentDatabaseOptions,
  preparedKeys?: SessionTranscriptSearchKeySet,
): SessionTranscriptSearchReadResult {
  const query = validateSessionTranscriptSearchQuery(params.query);
  const keys =
    preparedKeys ??
    (params.sessionKeys === undefined
      ? undefined
      : { encoded: encodeSqliteStringSet(params.sessionKeys), count: params.sessionKeys.length });
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
          const fullText = search.fullText;
          if (!fullText) {
            throw new DatabaseSearchCapabilityUnavailableError(
              "fullText",
              search.diagnostics.join("; "),
            );
          }
          const textIndex = search.text.transcript!;
          const fullQuery = sessionTranscriptSearchFtsQuery(query, params.match);
          const agentPrefix = toAgentStoreSessionKey({
            agentId: scope.agentId,
            requestKey: "*",
          }).slice(0, -1);
          // Only the palette's fixed native shape is prepared. All other callers,
          // including empty-key store-wide scope and CJK retries, retain their SQL.
          const prepared =
            !isPostgresSqlConnection(database.db) &&
            keys?.count &&
            params.sessionId === undefined &&
            !params.role &&
            params.order !== "recent"
              ? paletteSearchQueries(database.db)
              : undefined;
          const selectedWindows = (keySet?: RawBuilder<string>) =>
            db
              .selectFrom("session_windows")
              .select(["session_id", "session_key"])
              .where((eb) =>
                keys === undefined
                  ? eb.or([
                      isPostgresSqlConnection(database.db)
                        ? /* kysely-allow-raw: starts_with keeps underscores literal and, unlike left(), has planner selectivity, so the GIN match can drive the join. The prefix is a literal so reused prepared statements keep that estimate in their generic plan. */ sql<boolean>`${eb.ref("session_key")} ^@ ${sql.lit(agentPrefix)}`
                        : /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */ sql<boolean>`${eb.ref("session_key")} GLOB ${toAgentStoreSessionKey({ agentId: scope.agentId, requestKey: "*" })}`,
                      eb("session_key", "in", ["global", "unknown"]),
                    ])
                  : keys.count > 0
                    ? eb("session_key", "in", keySet ?? sqliteEncodedStringSet(keys.encoded))
                    : eb.and([]),
              )
              .$if(params.sessionId !== undefined, (builder) =>
                builder.where("session_id", "=", params.sessionId!),
              );
          const unpreparedWindows = prepared ? undefined : selectedWindows();
          const coldQuery = (encodedKeys?: RawBuilder<string>) =>
            keys?.count && !isPostgresSqlConnection(database.db)
              ? db
                  .selectFrom(sqliteStringSetEntries(encodedKeys ?? keys.encoded).as("selected"))
                  .crossJoin("session_windows as window")
                  .crossJoin("session_transcript_cold_archives as cold")
                  .whereRef("window.session_key", "=", "selected.value")
                  .whereRef("cold.session_id", "=", "window.session_id")
                  .$if(params.sessionId !== undefined, (builder) =>
                    builder.where("window.session_id", "=", params.sessionId!),
                  )
                  // De-duplicate matching archives, not the much larger input key set.
                  .select((eb) => eb.fn.count<number>("cold.session_id").distinct().as("count"))
              : db
                  .selectFrom("session_transcript_cold_archives as cold")
                  .innerJoin(
                    (unpreparedWindows ?? selectedWindows()).as("window"),
                    "window.session_id",
                    "cold.session_id",
                  )
                  .select((eb) => eb.fn.countAll<number>().as("count"));
          const archivedTranscriptsExcluded =
            (prepared
              ? (prepared.cold ??= prepareSqliteQueryTakeFirstSync<string, { count: number }>(
                  database.db,
                  (parameter) => coldQuery(parameter((value) => value)),
                ))(keys!.encoded)
              : executeSqliteQueryTakeFirstSync(database.db, coldQuery())
            )?.count ?? 0;
          let substringTerms: string[] = [];
          let hits: SessionTranscriptSearchResult["hits"];
          do {
            const literalQuery = {
              ...fullQuery,
              clauses: fullQuery.clauses.filter((clause) => !substringTerms.includes(clause.text)),
            };
            const useFts =
              literalQuery.clauses.length > 0 &&
              (substringTerms.length === 0 ||
                hasFullTextWordTokens(
                  database.db,
                  literalQuery.clauses.map((clause) => clause.text).join(" "),
                ));
            const ranking = fullText.rank(textIndex, literalQuery);
            const expression = expressionBuilder<DB, "session_transcript_fts">();
            const ftsMatch = useFts ? fullText.match(textIndex, literalQuery) : undefined;
            const match = expression.and([
              ...(ftsMatch ? [ftsMatch] : []),
              ...substringTerms.map((term) =>
                expression(
                  engineStringPosition(
                    database.db,
                    expression.fn<string>("lower", ["text"]),
                    expression.val(term.toLowerCase()),
                  ),
                  ">",
                  0,
                ),
              ),
            ]);
            const order =
              params.order === "recent"
                ? sql`session_transcript_fts.timestamp desc, fts_rowid desc`
                : sql`rank ${/* kysely-allow-raw: Capability order is the closed asc/desc union. */ sql.raw(ranking.order)}, session_transcript_fts.timestamp desc, session_transcript_fts.message_id asc`;
            const selectedHits = (
              selectedMatch: typeof match | RawBuilder<boolean> = match,
              selectedLimit: number | RawBuilder<number> = limit + 1,
              keySet?: RawBuilder<string>,
            ) => {
              // session_key lives on the window row so key renames
              // never leave stale keys inside the index. Sessions flagged needs_rebuild
              // are excluded: their rows may still hold rewound-away branch text that
              // sessions_history no longer exposes, so they stay hidden until reconcile
              // rebuilds them (indexing=true tells the caller to retry).
              // MATCH drives indexed reads; substring scans scope map rows before reading text.
              const candidates = (
                useFts
                  ? db
                      .selectFrom("session_transcript_fts")
                      .crossJoin("session_transcript_fts_rows as mapped")
                      .crossJoin((unpreparedWindows ?? selectedWindows(keySet)).as("window"))
                  : db
                      .selectFrom("session_transcript_fts_rows as mapped")
                      .crossJoin((unpreparedWindows ?? selectedWindows(keySet)).as("window"))
                      .crossJoin("session_transcript_fts")
              )
                .where("mapped.id", "=", fullText.identity(textIndex))
                .whereRef("window.session_id", "=", "mapped.session_id")
                .where(selectedMatch)
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
                  fullText.identity(textIndex).as("fts_rowid"),
                  useFts ? ranking.value.as("rank") : expression.val(0).as("rank"),
                ]);
              const postgres = isPostgresSqlConnection(database.db);
              // FTS5 owns these shadow columns in transcript field order. Read only
              // tie-break metadata after the rank cutoff, without reopening FTS cursors.
              const orderingDb = db.withTables<{
                session_transcript_fts_content: {
                  id: number;
                  c2: DB["session_transcript_fts"]["message_id"];
                  c4: DB["session_transcript_fts"]["timestamp"];
                };
              }>();
              const ordering = postgres
                ? db
                    .selectFrom("session_transcript_fts")
                    .select([fullText.identity(textIndex).as("id"), "timestamp", "message_id"])
                : orderingDb
                    .selectFrom("session_transcript_fts_content")
                    .select(["id", "c4 as timestamp", "c2 as message_id"]);
              return params.order === "recent" || !useFts
                ? candidates.orderBy(order).limit(selectedLimit)
                : orderingDb
                    .with(
                      (cte) => cte("scores").materialized(),
                      () => candidates,
                    )
                    .selectFrom("scores")
                    .crossJoin(ordering.as("ordering"))
                    .whereRef("ordering.id", "=", "scores.fts_rowid")
                    // Keep every tie at the cutoff before reading metadata for the final ordering.
                    .where("scores.rank", "in", (eb) =>
                      eb
                        .selectFrom("scores")
                        .select("rank")
                        .orderBy("rank", ranking.order)
                        .limit(selectedLimit),
                    )
                    .select(["scores.session_key", "scores.fts_rowid", "scores.rank"])
                    .orderBy("scores.rank", ranking.order)
                    .orderBy("ordering.timestamp", "desc")
                    .orderBy("ordering.message_id", "asc")
                    .limit(selectedLimit);
            };
            const rows = (() => {
              // PostgreSQL keeps its single-query path; native FTS can reuse a cursor
              // for an exact contiguous selection without scanning any extra row IDs.
              if (isPostgresSqlConnection(database.db)) {
                return executeSqliteQuerySync(
                  database.db,
                  db
                    .with(
                      (cte) => cte("hits").materialized(),
                      () => selectedHits(),
                    )
                    .selectFrom("hits")
                    .crossJoin("session_transcript_fts")
                    .where((eb) => eb(fullText.identity(textIndex), "=", eb.ref("hits.fts_rowid")))
                    .where(match)
                    .select([
                      "hits.session_key",
                      "session_transcript_fts.session_id",
                      "message_id",
                      "role",
                      "timestamp",
                      "hits.rank as rank",
                      substringTerms.length
                        ? expression.ref("text").as("snippet")
                        : fullText.snippet(textIndex, "text", 48, literalQuery).as("snippet"),
                    ])
                    .orderBy(order),
                ).rows;
              }
              const nativeDatabase = database.db;
              const selected =
                prepared && ftsMatch && substringTerms.length === 0
                  ? (prepared.hits ??= prepareSqliteQuerySync<
                      PaletteSearchBindings,
                      {
                        session_key: string;
                        fts_rowid: number;
                        rank: number;
                      }
                    >(database.db, (parameter) =>
                      selectedHits(
                        bindSqliteFullText(textIndex.store, nativeDatabase).matchBound(
                          textIndex,
                          parameter((value) => value.match),
                        ),
                        parameter((value) => value.limit),
                        /* kysely-allow-raw: reuse the canonical encoded-set fragment with a bound value. */
                        sql<string>(
                          sqliteStringSetFragments,
                          parameter((value) => value.keys),
                        ),
                      ),
                    ))({
                      keys: keys!.encoded,
                      match: sqliteFullTextLiteralQuery(literalQuery),
                      limit: limit + 1,
                    }).rows
                  : executeSqliteQuerySync(database.db, selectedHits()).rows;
              if (selected.length === 0) {
                return [];
              }
              const ids = selected.map((row) => row.fts_rowid);
              const first = Math.min(...ids);
              const last = Math.max(...ids);
              // Both reads remain inside the same synchronous snapshot. Sparse IDs
              // keep bounded individual seeks; a dense range needs one MATCH cursor.
              const content = executeSqliteQuerySync(
                database.db,
                db
                  .selectFrom("session_transcript_fts")
                  .where(match)
                  .where((eb) =>
                    last - first + 1 === ids.length
                      ? eb.between(fullText.identity(textIndex), first, last)
                      : eb(fullText.identity(textIndex), "in", ids),
                  )
                  .select([
                    fullText.identity(textIndex).as("fts_rowid"),
                    "session_id",
                    "message_id",
                    "role",
                    "timestamp",
                    substringTerms.length
                      ? expression.ref("text").as("snippet")
                      : fullText.snippet(textIndex, "text", 48, literalQuery).as("snippet"),
                  ]),
              ).rows;
              const byId = new Map(content.map((row) => [row.fts_rowid, row]));
              // Keep the score/timestamp/message ordering selected by the query owner.
              return selected.flatMap((hit) => {
                const row = byId.get(hit.fts_rowid);
                return row ? [{ ...hit, ...row }] : [];
              });
            })();
            hits = rows.flatMap((row): SessionTranscriptSearchResult["hits"] => {
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
                  snippet: boundSessionTranscriptSearchSnippet(row.snippet, substringTerms[0]),
                  score: ranking.toRank(rank),
                },
              ];
            });
            if (hits.length > 0 || substringTerms.length > 0) {
              break;
            }
            // unicode61 cannot address interior CJK text. Retry only misses; changing
            // the persisted tokenizer would rebuild every existing transcript index.
            substringTerms = fullQuery.clauses
              .map((clause) => clause.text)
              .filter((term) =>
                /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(
                  term,
                ),
              );
          } while (substringTerms.length > 0);
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
