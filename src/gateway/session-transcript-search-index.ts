// Gateway transcript search index backed by per-agent SQLite FTS5.
import fs from "node:fs/promises";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveSessionTranscriptReadTarget,
  type SessionTranscriptReadScope,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { extractAssistantVisibleText } from "../shared/chat-message-content.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { truncateUtf16Safe } from "../utils.js";
import { stripInlineDirectiveTagsForDisplay } from "../utils/directive-tags.js";
import { readSessionTranscriptIndex } from "./session-transcript-index.fs.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const MAX_INDEX_TEXT_CHARS = 8000;
const DEFAULT_SNIPPET_CHARS = 360;

type SearchSourceDatabase = Pick<OpenClawAgentKyselyDatabase, "session_transcript_search_sources">;

export type SessionTranscriptSearchTarget = {
  agentId: string;
  sessionKey: string;
  sessionId: string;
  sessionFile?: string;
  sessionEntry?: Pick<SessionEntry, "sessionFile"> & Partial<Pick<SessionEntry, "sessionId">>;
  storePath?: string;
};

export type SessionTranscriptSearchHit = {
  sessionKey: string;
  sessionId: string;
  agentId: string;
  seq: number;
  role: "user" | "assistant";
  snippet: string;
  timestampMs?: number;
  messageId?: string;
  rank?: number;
};

type SearchableTranscriptRow = {
  path: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  timestampMs?: number;
  messageId?: string;
};

type SearchQueryRow = {
  session_key: string;
  session_id: string;
  agent_id: string;
  seq: number | string;
  role: string;
  snippet: string;
  timestamp_ms: number | string | null;
  message_id: string | null;
  rank?: number;
};

function normalizeSearchLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(limit)));
}

function readMessageRole(message: unknown): "user" | "assistant" | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" ? role : undefined;
}

function extractUserVisibleText(message: Record<string, unknown>): string | undefined {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function readOpenClawMeta(message: Record<string, unknown>): Record<string, unknown> {
  const meta = message.__openclaw;
  return meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : {};
}

function extractSearchableMessageText(message: unknown): {
  role: "user" | "assistant";
  text: string;
  timestampMs?: number;
  messageId?: string;
} | null {
  const role = readMessageRole(message);
  if (!role || !message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as Record<string, unknown>;
  const rawText =
    role === "assistant" ? extractAssistantVisibleText(record) : extractUserVisibleText(record);
  const stripped = rawText ? stripInlineDirectiveTagsForDisplay(rawText).text.trim() : "";
  const redacted = stripped ? redactToolPayloadText(stripped).trim() : "";
  if (!redacted) {
    return null;
  }
  const meta = readOpenClawMeta(record);
  const timestampMs =
    typeof meta.recordTimestampMs === "number" && Number.isFinite(meta.recordTimestampMs)
      ? meta.recordTimestampMs
      : undefined;
  const messageId = normalizeOptionalString(meta.id);
  return {
    role,
    text:
      redacted.length > MAX_INDEX_TEXT_CHARS
        ? truncateUtf16Safe(redacted, MAX_INDEX_TEXT_CHARS)
        : redacted,
    ...(timestampMs !== undefined ? { timestampMs } : {}),
    ...(messageId ? { messageId } : {}),
  };
}

function indexedEntryToSearchRows(params: {
  path: string;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  entry: { seq: number; id?: string; record: Record<string, unknown> };
}): SearchableTranscriptRow[] {
  const message = params.entry.record.message;
  const searchable = extractSearchableMessageText(message);
  if (!searchable) {
    return [];
  }
  return [
    {
      path: params.path,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
      seq: params.entry.seq,
      role: searchable.role,
      text: searchable.text,
      ...(searchable.timestampMs !== undefined ? { timestampMs: searchable.timestampMs } : {}),
      ...((searchable.messageId ?? params.entry.id)
        ? { messageId: searchable.messageId ?? params.entry.id }
        : {}),
    },
  ];
}

function resolveTargetTranscriptPath(target: SessionTranscriptSearchTarget): string {
  const readScope: SessionTranscriptReadScope = {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}),
    ...(target.sessionEntry ? { sessionEntry: target.sessionEntry } : {}),
    ...(target.storePath ? { storePath: target.storePath } : {}),
  };
  return resolveSessionTranscriptReadTarget(readScope).sessionFile;
}

function readSearchSource(database: OpenClawAgentDatabase, path: string) {
  const kysely = getNodeSqliteKysely<SearchSourceDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("session_transcript_search_sources")
      .select(["mtime", "size", "session_key"])
      .where("path", "=", path),
  );
}

function deleteIndexedPath(database: OpenClawAgentDatabase, path: string): void {
  const kysely = getNodeSqliteKysely<SearchSourceDatabase>(database.db);
  runSqliteImmediateTransactionSync(database.db, () => {
    database.db.prepare("DELETE FROM session_transcript_search_fts WHERE path = ?").run(path);
    executeSqliteQuerySync(
      database.db,
      kysely.deleteFrom("session_transcript_search_sources").where("path", "=", path),
    );
  });
}

function replaceIndexedRows(params: {
  database: OpenClawAgentDatabase;
  target: SessionTranscriptSearchTarget;
  path: string;
  mtime: number;
  size: number;
  rows: SearchableTranscriptRow[];
}): void {
  const kysely = getNodeSqliteKysely<SearchSourceDatabase>(params.database.db);
  const now = Date.now();
  runSqliteImmediateTransactionSync(params.database.db, () => {
    params.database.db
      .prepare("DELETE FROM session_transcript_search_fts WHERE session_key = ? AND path <> ?")
      .run(params.target.sessionKey, params.path);
    params.database.db
      .prepare("DELETE FROM session_transcript_search_fts WHERE path = ?")
      .run(params.path);
    executeSqliteQuerySync(
      params.database.db,
      kysely
        .deleteFrom("session_transcript_search_sources")
        .where("session_key", "=", params.target.sessionKey)
        .where("path", "!=", params.path),
    );
    executeSqliteQuerySync(
      params.database.db,
      kysely
        .insertInto("session_transcript_search_sources")
        .values({
          path: params.path,
          session_key: params.target.sessionKey,
          session_id: params.target.sessionId,
          agent_id: params.target.agentId,
          mtime: params.mtime,
          size: params.size,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("path").doUpdateSet({
            session_key: params.target.sessionKey,
            session_id: params.target.sessionId,
            agent_id: params.target.agentId,
            mtime: params.mtime,
            size: params.size,
            updated_at: now,
          }),
        ),
    );
    const insert = params.database.db.prepare(
      [
        "INSERT INTO session_transcript_search_fts",
        "(path, session_key, session_id, agent_id, seq, message_id, role, timestamp_ms, text)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    );
    for (const row of params.rows) {
      insert.run(
        row.path,
        row.sessionKey,
        row.sessionId,
        row.agentId,
        row.seq,
        row.messageId ?? null,
        row.role,
        row.timestampMs ?? null,
        row.text,
      );
    }
  });
}

async function reconcileTargetIndex(params: {
  database: OpenClawAgentDatabase;
  target: SessionTranscriptSearchTarget;
}): Promise<boolean> {
  const path = resolveTargetTranscriptPath(params.target);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(path);
  } catch {
    deleteIndexedPath(params.database, path);
    return false;
  }
  if (!stat.isFile()) {
    deleteIndexedPath(params.database, path);
    return false;
  }
  const mtime = Math.floor(stat.mtimeMs);
  const size = stat.size;
  const source = readSearchSource(params.database, path);
  if (
    source?.mtime === mtime &&
    source.size === size &&
    source.session_key === params.target.sessionKey
  ) {
    return true;
  }
  const index = await readSessionTranscriptIndex(path, { cache: "reuse" });
  if (!index) {
    deleteIndexedPath(params.database, path);
    return false;
  }
  const rows = index.entries.flatMap((entry) =>
    indexedEntryToSearchRows({
      path,
      sessionKey: params.target.sessionKey,
      sessionId: params.target.sessionId,
      agentId: params.target.agentId,
      entry: {
        seq: entry.seq,
        ...(entry.id ? { id: entry.id } : {}),
        record: entry.record,
      },
    }),
  );
  replaceIndexedRows({
    database: params.database,
    target: params.target,
    path,
    mtime,
    size,
    rows,
  });
  return true;
}

function buildFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" ");
}

function escapeLikeQuery(query: string): string {
  return query.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeQueryRow(row: SearchQueryRow): SessionTranscriptSearchHit | null {
  const role = row.role === "user" || row.role === "assistant" ? row.role : undefined;
  const seq = typeof row.seq === "number" ? row.seq : Number(row.seq);
  if (!role || !Number.isFinite(seq)) {
    return null;
  }
  const timestampMs =
    typeof row.timestamp_ms === "number"
      ? row.timestamp_ms
      : typeof row.timestamp_ms === "string" && row.timestamp_ms
        ? Number(row.timestamp_ms)
        : undefined;
  return {
    sessionKey: row.session_key,
    sessionId: row.session_id,
    agentId: row.agent_id,
    seq,
    role,
    snippet: row.snippet,
    ...(timestampMs !== undefined && Number.isFinite(timestampMs) ? { timestampMs } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(typeof row.rank === "number" && Number.isFinite(row.rank) ? { rank: row.rank } : {}),
  };
}

function createFallbackSnippet(text: string, query: string): string {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const matchAt = haystack.indexOf(needle);
  const center = matchAt >= 0 ? matchAt : 0;
  const start = Math.max(0, center - Math.floor(DEFAULT_SNIPPET_CHARS / 2));
  const raw = text.slice(start, start + DEFAULT_SNIPPET_CHARS);
  return `${start > 0 ? "..." : ""}${raw}${start + raw.length < text.length ? "..." : ""}`;
}

function queryAgentIndex(params: {
  database: OpenClawAgentDatabase;
  sessionKeys: string[];
  query: string;
  limit: number;
}): SessionTranscriptSearchHit[] {
  const ftsQuery = buildFtsQuery(params.query);
  if (!ftsQuery || params.sessionKeys.length === 0) {
    return [];
  }
  const placeholders = params.sessionKeys.map(() => "?").join(", ");
  try {
    const rows = params.database.db
      .prepare(
        [
          "SELECT session_key, session_id, agent_id, seq, role,",
          "snippet(session_transcript_search_fts, 8, '[', ']', '...', 12) AS snippet,",
          "timestamp_ms, message_id, bm25(session_transcript_search_fts) AS rank",
          "FROM session_transcript_search_fts",
          "WHERE session_transcript_search_fts MATCH ?",
          `AND session_key IN (${placeholders})`,
          "ORDER BY rank ASC, timestamp_ms DESC",
          "LIMIT ?",
        ].join(" "),
      )
      .all(ftsQuery, ...params.sessionKeys, params.limit) as SearchQueryRow[];
    return rows.flatMap((row) => {
      const hit = normalizeQueryRow(row);
      return hit ? [hit] : [];
    });
  } catch {
    const like = `%${escapeLikeQuery(params.query)}%`;
    const rows = params.database.db
      .prepare(
        [
          "SELECT session_key, session_id, agent_id, seq, role, text AS snippet,",
          "timestamp_ms, message_id",
          "FROM session_transcript_search_fts",
          `WHERE session_key IN (${placeholders})`,
          "AND text LIKE ? ESCAPE '\\'",
          "ORDER BY timestamp_ms DESC",
          "LIMIT ?",
        ].join(" "),
      )
      .all(...params.sessionKeys, like, params.limit) as SearchQueryRow[];
    return rows.flatMap((row) => {
      const normalized = normalizeQueryRow({
        ...row,
        snippet: createFallbackSnippet(row.snippet, params.query),
      });
      return normalized ? [normalized] : [];
    });
  }
}

export async function searchSessionTranscripts(params: {
  targets: SessionTranscriptSearchTarget[];
  query: string;
  limit?: number;
}): Promise<{ hits: SessionTranscriptSearchHit[]; indexedSessions: number }> {
  const query = params.query.trim();
  const limit = normalizeSearchLimit(params.limit);
  if (!query || params.targets.length === 0) {
    return { hits: [], indexedSessions: 0 };
  }
  const targetsByAgent = new Map<string, SessionTranscriptSearchTarget[]>();
  for (const target of params.targets) {
    const agentId = normalizeAgentId(target.agentId);
    const list = targetsByAgent.get(agentId) ?? [];
    list.push({ ...target, agentId });
    targetsByAgent.set(agentId, list);
  }
  const hits: SessionTranscriptSearchHit[] = [];
  let indexedSessions = 0;
  for (const [agentId, targets] of targetsByAgent) {
    const database = openOpenClawAgentDatabase({ agentId });
    const indexedKeys: string[] = [];
    for (const target of targets) {
      if (await reconcileTargetIndex({ database, target })) {
        indexedSessions += 1;
        indexedKeys.push(target.sessionKey);
      }
    }
    hits.push(
      ...queryAgentIndex({
        database,
        sessionKeys: Array.from(new Set(indexedKeys)),
        query,
        limit,
      }),
    );
  }
  return {
    hits: hits
      .toSorted((a, b) => {
        const rankA = a.rank ?? Number.POSITIVE_INFINITY;
        const rankB = b.rank ?? Number.POSITIVE_INFINITY;
        if (rankA !== rankB) {
          return rankA - rankB;
        }
        return (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
      })
      .slice(0, limit),
    indexedSessions,
  };
}
