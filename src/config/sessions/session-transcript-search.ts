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
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { hasSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;

type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  messageId: string;
  role: "assistant" | "user";
  timestamp: number;
  snippet: string;
  score: number;
};

type SessionTranscriptSearchResult = {
  hits: SessionTranscriptSearchHit[];
  indexing: boolean;
  truncated: boolean;
  archivedTranscriptsExcluded?: number;
};

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

/** Tracks both transcript changes and search availability for derived-result caches. */
export function readSessionTranscriptSearchVersion(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  sessionId: string;
  sessionKey?: string;
  storePath?: string;
}): string | null {
  const scope = resolveSqliteReadScope(params);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const db = getNodeSqliteKysely<DB>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_windows as window")
          .leftJoin(
            "transcript_rewrite_watermarks as rewrite",
            "rewrite.session_id",
            "window.session_id",
          )
          .leftJoin(
            "session_transcript_index_state as projection",
            "projection.session_id",
            "window.session_id",
          )
          .leftJoin(
            "session_transcript_cold_archives as cold",
            "cold.session_id",
            "window.session_id",
          )
          .select((eb) => [
            "rewrite.generation",
            "projection.indexed_seq",
            "projection.leaf_event_id",
            "projection.needs_rebuild",
            "projection.updated_at",
            "cold.archive_sha256",
            eb
              .selectFrom("transcript_events as event")
              .select("event.seq")
              .whereRef("event.session_id", "=", "window.session_id")
              .orderBy("event.seq", "desc")
              .limit(1)
              .as("max_seq"),
          ])
          .where("window.session_id", "=", params.sessionId),
      );
      if (!row) {
        return null;
      }
      const { identity, incarnation } = readOpenClawAgentDatabaseIdentity(database);
      const databaseIdentity =
        typeof identity === "string" ? ["file", identity] : ["incognito", incarnation];
      return JSON.stringify([databaseIdentity, row]);
    },
    toDatabaseOptions(scope),
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : null;
}

/** Search the per-agent FTS index; kicks off one background reconcile when the index lags. */
export function searchSessionTranscripts(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  role?: "assistant" | "user";
  sessionId?: string;
  sessionKeys?: string[];
  order?: "relevance" | "recent";
  storePath?: string;
}): SessionTranscriptSearchResult {
  const query = params.query.trim();
  if (!query) {
    throw new Error("query must not be empty");
  }
  if (query.length > SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`query must not exceed ${SEARCH_QUERY_MAX_CHARS} characters`);
  }
  const scope = resolveSqliteReadScope(params);
  const databaseOptions = toDatabaseOptions(scope);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteDeferredTransactionSync(
        database.db,
        () => {
          const hasDirtySessions = hasSessionsNeedingTranscriptIndexReconcile(database.db);
          if (hasDirtySessions) {
            startSessionTranscriptIndexReconcile(databaseOptions);
          }
          const indexing =
            hasDirtySessions || isSessionTranscriptIndexReconcileRunning(databaseOptions);
          const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
          // Shared databases hold multiple logical agents. Filter before LIMIT;
          // reserved global/unknown sentinels retain their store-wide scope.
          const sessionFilterValues = params.sessionKeys ?? [
            toAgentStoreSessionKey({ agentId: scope.agentId, requestKey: "*" }),
          ];
          const sessionKeySet = sqliteStringSet(sessionFilterValues);
          const db = getNodeSqliteKysely<DB>(database.db);
          const archivedTranscriptsExcluded =
            executeSqliteQueryTakeFirstSync(
              database.db,
              db
                .selectFrom("session_transcript_cold_archives as cold")
                .innerJoin("session_windows as window", "window.session_id", "cold.session_id")
                .select((eb) => eb.fn.countAll<number>().as("count"))
                .$if(params.sessionKeys === undefined, (builder) =>
                  builder.where((eb) =>
                    eb.or([
                      /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */
                      sql<boolean>`${eb.ref("window.session_key")} GLOB ${sessionFilterValues[0]}`,
                      eb("window.session_key", "in", ["global", "unknown"]),
                    ]),
                  ),
                )
                .$if(
                  params.sessionKeys !== undefined && sessionFilterValues.length > 0,
                  (builder) => builder.where("window.session_key", "in", sessionKeySet),
                )
                .$if(params.sessionId !== undefined, (builder) =>
                  builder.where("window.session_id", "=", params.sessionId!),
                ),
            )?.count ?? 0;
          // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
          // representation. session_key lives on the window row so key renames
          // never leave stale keys inside the index. Sessions flagged needs_rebuild
          // are excluded: their rows may still hold rewound-away branch text that
          // sessions_history no longer exposes, so they stay hidden until reconcile
          // rebuilds them (indexing=true tells the caller to retry).
          const rows = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_transcript_fts")
              .innerJoin(
                "session_windows",
                "session_windows.session_id",
                "session_transcript_fts.session_id",
              )
              .select([
                "session_windows.session_key",
                "session_transcript_fts.session_id",
                "message_id",
                "role",
                "timestamp",
                /* kysely-allow-raw: FTS5 snippet primitive. */
                sql`snippet(session_transcript_fts, 0, '', '', ' … ', 48)`.as("snippet"),
                /* kysely-allow-raw: FTS5 ranking primitive. */
                sql`bm25(session_transcript_fts)`.as("rank"),
              ])
              .where(
                /* kysely-allow-raw: FTS5 table MATCH with a bound search query. */
                sql<boolean>`session_transcript_fts MATCH ${toFtsQuery(query)}`,
              )
              .$if(params.sessionKeys === undefined, (builder) =>
                builder.where((eb) =>
                  eb.or([
                    /* kysely-allow-raw: GLOB preserves literal underscores in SQLite agent namespaces. */
                    sql<boolean>`${eb.ref("session_windows.session_key")} GLOB ${sessionFilterValues[0]}`,
                    eb("session_windows.session_key", "in", ["global", "unknown"]),
                  ]),
                ),
              )
              .$if(params.sessionKeys !== undefined && sessionFilterValues.length > 0, (builder) =>
                builder.where("session_windows.session_key", "in", sessionKeySet),
              )
              .$if(Boolean(params.sessionId), (builder) =>
                builder.where("session_transcript_fts.session_id", "=", params.sessionId!),
              )
              .$if(Boolean(params.role), (builder) => builder.where("role", "=", params.role!))
              .where(
                "session_transcript_fts.session_id",
                "not in",
                db
                  .selectFrom("session_transcript_index_state")
                  .select("session_id")
                  .where("needs_rebuild", "!=", 0)
                  .$if(Boolean(params.sessionId), (builder) =>
                    builder.where("session_id", "=", params.sessionId!),
                  ),
              )
              .$if(params.order === "recent", (builder) =>
                builder
                  .orderBy("timestamp", "desc")
                  /* kysely-allow-raw: FTS5 implicit rowid is not a generated schema column. */
                  .orderBy(sql`session_transcript_fts.rowid`, "desc"),
              )
              .$if(params.order !== "recent", (builder) =>
                builder
                  .orderBy("rank", "asc")
                  .orderBy("timestamp", "desc")
                  .orderBy("message_id", "asc"),
              )
              .limit(limit + 1),
          ).rows;
          const hits = rows.flatMap((row): SessionTranscriptSearchHit[] => {
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
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : { hits: [], indexing: false, truncated: false };
}
