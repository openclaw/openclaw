// Full-text search over per-agent transcript rows. Appends index themselves
// inside the accessor's write transactions (session-transcript-index.ts);
// this module owns the query path and schedules the shared reconcile owner
// when doctor imports or out-of-band writes leave derived rows behind.
import { toAgentStoreSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { truncateUtf16Safe } from "../../utils.js";
import { resolveSqliteReadScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import { listSessionsNeedingTranscriptIndexReconcile } from "./session-transcript-index.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";

const SEARCH_SNIPPET_MAX_CHARS = 500;
// Roughly matches the MATCH path's 48-token snippet radius for the fallback's
// char-based excerpt window.
const SEARCH_EXCERPT_MARGIN_CHARS = 160;
const SEARCH_LIMIT_MAX = 25;
const SEARCH_QUERY_MAX_CHARS = 4096;
// Runs of Han/Kana/Hangul have no spaces for the unicode61 tokenizer to split
// on, so any exact-phrase term overlapping such a run is unaddressable by the
// FTS index and needs the LIKE retry below.
const CJK_RUN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2,}/u;

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
};

function toFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/u)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function toLikePattern(term: string): string {
  return `%${term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

// snippet() needs MATCH phrase locations, which the LIKE retry does not have;
// cut a bounded window around the first term hit instead so excerpts stay
// anchored to the match rather than the start of the message.
function toMatchExcerpt(text: string, terms: string[]): string {
  const haystack = text.toLowerCase();
  let index = -1;
  let matchedLength = 0;
  for (const term of terms) {
    const at = haystack.indexOf(term.toLowerCase());
    if (at !== -1 && (index === -1 || at < index)) {
      index = at;
      matchedLength = term.length;
    }
  }
  if (index === -1) {
    return `${truncateUtf16Safe(text, SEARCH_EXCERPT_MARGIN_CHARS)} …`;
  }
  const start = Math.max(0, index - SEARCH_EXCERPT_MARGIN_CHARS);
  const end = Math.min(text.length, index + matchedLength + SEARCH_EXCERPT_MARGIN_CHARS);
  return `${start > 0 ? "… " : ""}${text.slice(start, end)}${end < text.length ? " …" : ""}`;
}

/** Search the per-agent FTS index; kicks off one background reconcile when the index lags. */
export function searchSessionTranscripts(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  query: string;
  sessionKeys?: string[];
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
    (database) => {
      const dirtySessions = listSessionsNeedingTranscriptIndexReconcile(database.db);
      if (dirtySessions.length > 0) {
        startSessionTranscriptIndexReconcile(databaseOptions);
      }
      const indexing =
        dirtySessions.length > 0 || isSessionTranscriptIndexReconcileRunning(databaseOptions);
      const limit = Math.min(Math.max(1, params.limit ?? 10), SEARCH_LIMIT_MAX);
      // Shared databases hold multiple logical agents. Filter before LIMIT;
      // reserved global/unknown sentinels retain their store-wide scope.
      const sessionFilterValues = params.sessionKeys ?? [
        toAgentStoreSessionKey({ agentId: scope.agentId, requestKey: "*" }),
      ];
      const whereSession =
        params.sessionKeys === undefined
          ? " AND (session_windows.session_key GLOB ? OR session_windows.session_key IN ('global', 'unknown'))"
          : sessionFilterValues.length > 0
            ? ` AND session_windows.session_key IN (${sessionFilterValues.map(() => "?").join(", ")})`
            : "";
      // MATCH, snippet(), and bm25() are FTS5 primitives without a Kysely
      // representation. session_key lives on the window row so key renames
      // never leave stale keys inside the index. Sessions flagged needs_rebuild
      // are excluded: their rows may still hold rewound-away branch text that
      // sessions_history no longer exposes, so they stay hidden until reconcile
      // rebuilds them (indexing=true tells the caller to retry).
      const statement = database.db.prepare(/* sqlite-allow-raw: FTS5 MATCH/snippet/bm25 */ `
    SELECT session_windows.session_key AS session_key, session_transcript_fts.session_id AS session_id,
      message_id, role, timestamp,
      snippet(session_transcript_fts, 0, '', '', ' … ', 48) AS snippet,
      bm25(session_transcript_fts) AS rank
    FROM session_transcript_fts
    JOIN session_windows ON session_windows.session_id = session_transcript_fts.session_id
    WHERE session_transcript_fts MATCH ?${whereSession}
      AND session_transcript_fts.session_id NOT IN (
        SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
      )
    ORDER BY rank ASC, timestamp DESC, message_id ASC
    LIMIT ?
    `);
      const values = [toFtsQuery(query), ...sessionFilterValues, limit + 1];
      type TranscriptSearchRow = {
        message_id: unknown;
        rank: unknown;
        role: unknown;
        session_id: unknown;
        session_key: unknown;
        raw_text: unknown;
        snippet: unknown;
        timestamp: unknown;
      };
      let rows = statement.all(...values) as TranscriptSearchRow[];
      if (rows.length === 0 && CJK_RUN_PATTERN.test(query)) {
        const terms = query.split(/\s+/u).filter(Boolean);
        // Only CJK-run terms are unaddressable by the unicode61 tokenizer; the
        // rest keep their exact-word MATCH semantics so a mixed query like
        // "会议 cat" cannot widen into a substring match on any term.
        const cjkTerms = terms.filter((term) => CJK_RUN_PATTERN.test(term));
        const ftsTerms = terms.filter((term) => !CJK_RUN_PATTERN.test(term));
        if (cjkTerms.length > 0) {
          const matchClause = ftsTerms.length > 0 ? "session_transcript_fts MATCH ? AND " : "";
          // The zero-hit gate keeps this scan off every served query; the LIKE
          // terms reuse the FTS row text so filters behave like the MATCH path,
          // and the excerpt is rebuilt around the matched substring.
          const fallbackStatement = database.db.prepare(/* sqlite-allow-raw: FTS5 MATCH/LIKE */ `
      SELECT session_windows.session_key AS session_key, session_transcript_fts.session_id AS session_id,
        message_id, role, timestamp,
        session_transcript_fts.text AS raw_text
      FROM session_transcript_fts
      JOIN session_windows ON session_windows.session_id = session_transcript_fts.session_id
      WHERE ${matchClause}${cjkTerms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ")}${whereSession}
        AND session_transcript_fts.session_id NOT IN (
          SELECT session_id FROM session_transcript_index_state WHERE needs_rebuild != 0
        )
      ORDER BY timestamp DESC, message_id ASC
      LIMIT ?
    `);
          const fallbackValues = [
            ...(ftsTerms.length > 0 ? [toFtsQuery(ftsTerms.join(" "))] : []),
            ...cjkTerms.map(toLikePattern),
            ...sessionFilterValues,
            limit + 1,
          ];
          // SAFETY: FTS rows are the fixed column projection selected above, owned by the schema.
          rows = (fallbackStatement.all(...fallbackValues) as TranscriptSearchRow[]).map((row) =>
            Object.assign({}, row, {
              snippet:
                typeof row.raw_text === "string" ? toMatchExcerpt(row.raw_text, cjkTerms) : "",
            }),
          );
        }
      }
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
        const timestamp = typeof row.timestamp === "number" ? row.timestamp : Number(row.timestamp);
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
      return { hits: hits.slice(0, limit), indexing, truncated: hits.length > limit };
    },
    databaseOptions,
    { throwOnMissingTable: true },
  );
  return result.found ? result.value : { hits: [], indexing: false, truncated: false };
}
