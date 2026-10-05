// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { truncateUtf16Safe } from "../../utils.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  prepareIncognitoSessionHistoryRead,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { hasSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type {
  SessionTranscriptSearchParams,
  SessionTranscriptSearchResult,
} from "./session-transcript-search.types.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;

function toFtsQuery(query: string, match: SessionTranscriptSearchParams["match"]): string {
  return query
    .split(/\s+/u)
    .map(
      (token, index, tokens) =>
        `"${token.replaceAll('"', '""')}"${match === "prefix" && index === tokens.length - 1 ? "*" : ""}`,
    )
    .join(" AND ");
}

/** Query a captured disk owner off-thread; reconciliation remains host-owned. */
export async function searchSessionTranscripts(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: { agentId: string; path: string },
  incognito?: IncognitoSessionHistoryBinding,
): Promise<SessionTranscriptSearchResult> {
  validateSearchQuery(params.query);
  if (incognito) {
    if (
      params.sessionKeys &&
      (params.sessionKeys.length !== 1 || params.sessionKeys[0] !== incognito.target.sessionKey)
    ) {
      throw new Error("Incognito search requires its captured session selection");
    }
    const prepared = prepareIncognitoSessionHistoryRead(incognito, {
      ...params,
      sessionId: params.sessionId ?? incognito.target.sessionId,
      storePath: preparedDatabase?.path ?? params.storePath,
    });
    const { actor, target } = prepared;
    const projection = { actor, authority: incognito.authority };
    const database = captureLifecycleDatabaseScope({
      agentId: actor.agentId,
      path: actor.path,
      env: params.env,
    });
    const result = await actor.sessions.history(prepared.authority, {
      type: "session.history.search",
      input: {
        ...target,
        query: params.query,
        limit: params.limit,
        match: params.match,
        role: params.role,
        order: params.order,
      },
    });
    prepared.authority.assertCurrent();
    if (result.result.indexing) {
      startSessionTranscriptIndexReconcile(
        { ...database, preferredSessionId: target.sessionId },
        projection,
      );
    }
    return {
      ...result.result,
      indexing:
        result.result.indexing || isSessionTranscriptIndexReconcileRunning(database, projection),
    };
  }
  const scope = captureLifecycleDatabaseScope(
    preparedDatabase
      ? {
          agentId: params.agentId,
          databaseAgentId: preparedDatabase.agentId,
          path: preparedDatabase.path,
          env: params.env,
        }
      : resolveSqliteReadScope(params),
  );
  const options = toDatabaseOptions(scope);
  const request = {
    ...params,
    agentId: scope.agentId,
    env: scope.env,
    sessionKeys: params.sessionKeys?.slice(),
  };
  const finish = (result: SessionTranscriptSearchResult): SessionTranscriptSearchResult => {
    if (result.indexing) {
      startSessionTranscriptIndexReconcile(options);
    }
    return {
      ...result,
      indexing: result.indexing || isSessionTranscriptIndexReconcileRunning(options),
    };
  };
  if (isIncognitoOpenClawAgentSqlitePath(resolveOpenClawAgentSqlitePath(options), options)) {
    // Process-local SQLite cannot cross the worker boundary without changing its lifetime.
    return finish(searchSessionTranscriptsReadOnlySync(request, options));
  }
  return await withSessionHistoryWorkerDatabase(options, async (owner) => {
    const result = await owner.searchTranscripts(request);
    owner.assertCurrent();
    return finish(result);
  });
}

function validateSearchQuery(input: string): string {
  const query = input.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  return query;
}

/** Native read kernel; indexing reports dirty rows without scheduling a writer. */
export function searchSessionTranscriptsReadOnlySync(
  params: SessionTranscriptSearchParams,
  preparedDatabase?: OpenClawAgentDatabaseOptions,
): SessionTranscriptSearchResult {
  const query = validateSearchQuery(params.query);
  const scope = preparedDatabase ? { agentId: params.agentId } : resolveSqliteReadScope(params);
  const databaseOptions = preparedDatabase ?? toDatabaseOptions(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const indexing = hasSessionsNeedingTranscriptIndexReconcile(database.db);
          const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
          // Shared databases hold multiple logical agents. Filter before LIMIT;
          // reserved global/unknown sentinels retain their store-wide scope.
          const db = getNodeSqliteKysely<DB>(database.db);
          const selectedWindows = db
            .selectFrom("session_windows")
            .select(["session_id", "session_key"])
            .where((eb) =>
              params.sessionKeys === undefined
                ? eb.or([
                    /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */
                    sql<boolean>`${eb.ref("session_key")} GLOB ${toAgentStoreSessionKey({ agentId: scope.agentId, requestKey: "*" })}`,
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
          const match =
            /* kysely-allow-raw: FTS5 table MATCH with a bound search query. */
            sql<boolean>`session_transcript_fts MATCH ${toFtsQuery(query, params.match)}`;
          /* kysely-allow-raw: Shared FTS ordering, including SQLite-only rowid for recent ties. */
          const order =
            params.order === "recent"
              ? sql`session_transcript_fts.timestamp desc, fts_rowid desc`
              : sql`rank asc, session_transcript_fts.timestamp desc, session_transcript_fts.message_id asc`;
          // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
          // representation. session_key lives on the window row so key renames
          // never leave stale keys inside the index. Sessions flagged needs_rebuild
          // are excluded: their rows may still hold rewound-away branch text that
          // sessions_history no longer exposes, so they stay hidden until reconcile
          // rebuilds them (indexing=true tells the caller to retry).
          const candidates = db
            .selectFrom("session_transcript_fts")
            // Keep MATCH outermost; the narrow map rejects excluded content before hydration.
            .crossJoin("session_transcript_fts_rows as mapped")
            .crossJoin(selectedWindows.as("window"))
            .where(
              "mapped.id",
              "=",
              /* kysely-allow-raw: FTS5 implicit rowid stays inside SQLite, including 64-bit identities. */
              sql<number>`session_transcript_fts.rowid`,
            )
            .whereRef("window.session_id", "=", "mapped.session_id")
            .where(match)
            // Depend on the scoped window so SQLite cannot read role before excluding sessions.
            .$if(Boolean(params.role), (builder) =>
              builder.where((eb) =>
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
              /* kysely-allow-raw: FTS5 implicit rowid is not a generated schema column. */
              sql`session_transcript_fts.rowid`.as("fts_rowid"),
              /* kysely-allow-raw: FTS5 ranking primitive. */
              sql`bm25(session_transcript_fts)`.as("rank"),
            ])
            .orderBy(order)
            .limit(limit + 1);
          const rows = executeSqliteQuerySync(
            database.db,
            db
              .with(
                (cte) => cte("hits").materialized(),
                () => candidates,
              )
              .selectFrom("hits")
              .crossJoin("session_transcript_fts")
              /* kysely-allow-raw: Bound FTS5 hydration only visits the retained candidate rowids. */
              .where((eb) => eb(sql`session_transcript_fts.rowid`, "=", eb.ref("hits.fts_rowid")))
              .where(match)
              .select([
                "hits.session_key",
                "session_transcript_fts.session_id",
                "message_id",
                "role",
                "timestamp",
                "hits.rank as rank",
                /* kysely-allow-raw: Materialization bounds snippet tokenization to limit + 1 rows. */
                sql`snippet(session_transcript_fts, 0, '', '', ' … ', 48)`.as("snippet"),
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
                snippet:
                  row.snippet.length > SEARCH_SNIPPET_MAX_CHARS
                    ? `${truncateUtf16Safe(row.snippet, SEARCH_SNIPPET_MAX_CHARS)}…`
                    : row.snippet,
                score: Number.isFinite(rank) ? -rank : 0,
              },
            ];
          });
          return {
            hits: hits.slice(0, limit),
            indexing,
            truncated: hits.length > limit,
            ...(archivedTranscriptsExcluded > 0 ? { archivedTranscriptsExcluded } : {}),
          };
        },
        { databaseLabel: database.path, operationLabel: "session transcript search" },
      ),
    databaseOptions,
  );
  return result.found ? result.value : { hits: [], indexing: false, truncated: false };
}
