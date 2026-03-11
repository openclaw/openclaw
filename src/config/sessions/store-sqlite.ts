/**
 * SQLite adapter for the session store.
 *
 * Maps between the in-memory `Record<string, SessionEntry>` format
 * and the `session_entries` table in operator1.db.
 *
 * Dedicated columns cover high-query fields; everything else
 * lives in the `extra_json` TEXT column.
 */
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../../infra/state-db/connection.js";
import { runMigrations } from "../../infra/state-db/schema.js";
import type { SessionEntry } from "./types.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

/**
 * Override the DB connection used by session store SQLite functions.
 * For tests only. The provided DB must have session_entries table.
 */
export function setSessionStoreDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

/** Reset the test DB override. */
export function resetSessionStoreDbForTest(): void {
  _dbOverride = null;
}

/**
 * Initialize a test DB with session_entries table.
 * Returns the DatabaseSync instance for use in tests.
 */
export function initSessionStoreTestDb(db: DatabaseSync): DatabaseSync {
  runMigrations(db);
  setSessionStoreDbForTest(db);
  return db;
}

function resolveDb(db?: DatabaseSync): DatabaseSync {
  return db ?? _dbOverride ?? getStateDb();
}

// ── Agent ID extraction ─────────────────────────────────────────────────────

/**
 * Extract agent ID from a legacy `storePath`.
 *
 * storePath pattern: `~/.openclaw/agents/{agentId}/sessions/sessions.json`
 * Returns the agentId segment, or "default" if the path doesn't match.
 */
export function extractAgentIdFromStorePath(storePath: string): string {
  const parts = path.normalize(storePath).split(path.sep);
  const sessionsIdx = parts.lastIndexOf("sessions");
  if (sessionsIdx >= 2 && parts[sessionsIdx - 2] === "agents") {
    const agentId = parts[sessionsIdx - 1];
    if (agentId) {
      return agentId;
    }
  }
  return "default";
}

// ── Column ↔ SessionEntry mapping ───────────────────────────────────────────

/**
 * Fields that have dedicated columns in `session_entries`.
 * Everything else goes into `extra_json`.
 */
const DEDICATED_FIELDS = new Set<string>([
  "sessionId",
  "sessionFile",
  "channel",
  "lastChannel",
  "lastTo",
  "lastAccountId",
  "lastThreadId",
  "deliveryContext",
  "origin",
  "displayName",
  "model",
  "updatedAt",
]);

type SessionEntryRow = {
  agent_id: string;
  session_key: string;
  session_id: string | null;
  session_file: string | null;
  channel: string | null;
  last_channel: string | null;
  last_to: string | null;
  last_account_id: string | null;
  last_thread_id: string | null;
  delivery_context_json: string | null;
  origin_json: string | null;
  display_name: string | null;
  group_name: string | null;
  model: string | null;
  department: string | null;
  created_at: number | null;
  updated_at: number | null;
  extra_json: string | null;
};

/** Convert a SessionEntry to a row object for INSERT/UPDATE. */
function sessionEntryToRow(
  agentId: string,
  sessionKey: string,
  entry: SessionEntry,
): SessionEntryRow {
  // Collect extra fields (anything not in a dedicated column)
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!DEDICATED_FIELDS.has(key) && value !== undefined) {
      extra[key] = value;
    }
  }

  return {
    agent_id: agentId,
    session_key: sessionKey,
    session_id: entry.sessionId ?? null,
    session_file: entry.sessionFile ?? null,
    channel: entry.channel ?? null,
    last_channel: entry.lastChannel ?? null,
    last_to: entry.lastTo ?? null,
    last_account_id: entry.lastAccountId ?? null,
    last_thread_id: entry.lastThreadId != null ? String(entry.lastThreadId) : null,
    delivery_context_json: entry.deliveryContext ? JSON.stringify(entry.deliveryContext) : null,
    origin_json: entry.origin ? JSON.stringify(entry.origin) : null,
    display_name: entry.displayName ?? null,
    group_name: null,
    model: entry.model ?? null,
    department: null,
    created_at: null,
    updated_at: entry.updatedAt ?? null,
    extra_json: Object.keys(extra).length > 0 ? JSON.stringify(extra) : null,
  };
}

/** Convert a DB row back to a SessionEntry. */
function rowToSessionEntry(row: SessionEntryRow): SessionEntry {
  const entry: SessionEntry = {
    sessionId: row.session_id ?? "",
    updatedAt: row.updated_at ?? 0,
  };

  if (row.session_file) {
    entry.sessionFile = row.session_file;
  }
  if (row.channel) {
    entry.channel = row.channel;
  }
  if (row.last_channel) {
    entry.lastChannel = row.last_channel as SessionEntry["lastChannel"];
  }
  if (row.last_to) {
    entry.lastTo = row.last_to;
  }
  if (row.last_account_id) {
    entry.lastAccountId = row.last_account_id;
  }
  if (row.last_thread_id != null) {
    // Preserve numeric thread IDs if they were numeric originally
    const numVal = Number(row.last_thread_id);
    entry.lastThreadId =
      Number.isFinite(numVal) && String(numVal) === row.last_thread_id
        ? numVal
        : row.last_thread_id;
  }
  if (row.delivery_context_json) {
    try {
      entry.deliveryContext = JSON.parse(row.delivery_context_json);
    } catch {
      // Corrupt JSON — skip
    }
  }
  if (row.origin_json) {
    try {
      entry.origin = JSON.parse(row.origin_json);
    } catch {
      // Corrupt JSON — skip
    }
  }
  if (row.display_name) {
    entry.displayName = row.display_name;
  }
  if (row.model) {
    entry.model = row.model;
  }

  // Merge extra_json fields
  if (row.extra_json) {
    try {
      const extra = JSON.parse(row.extra_json);
      if (extra && typeof extra === "object" && !Array.isArray(extra)) {
        Object.assign(entry, extra);
      }
    } catch {
      // Corrupt JSON — skip
    }
  }

  return entry;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Load all session entries for an agent from SQLite. */
export function loadSessionEntriesFromDb(
  agentId: string,
  db?: DatabaseSync,
): Record<string, SessionEntry> {
  const conn = resolveDb(db);
  try {
    const rows = conn
      .prepare("SELECT * FROM session_entries WHERE agent_id = ?")
      .all(agentId) as SessionEntryRow[];

    const store: Record<string, SessionEntry> = {};
    for (const row of rows) {
      store[row.session_key] = rowToSessionEntry(row);
    }
    return store;
  } catch (err) {
    // Table may not exist yet (e.g. tests without DB init).
    // Graceful fallback — same as reading a missing JSON file.
    if (err instanceof Error && err.message.includes("no such table")) {
      return {};
    }
    throw err;
  }
}

/** Persist the full session store for an agent to SQLite (delete + insert all). */
export function saveSessionEntriesToDb(
  agentId: string,
  store: Record<string, SessionEntry>,
  db?: DatabaseSync,
): void {
  const conn = resolveDb(db);

  try {
    conn.exec("BEGIN");
    try {
      // Delete all existing entries for this agent
      conn.prepare("DELETE FROM session_entries WHERE agent_id = ?").run(agentId);

      // Insert all current entries
      const insert = conn.prepare(`
        INSERT INTO session_entries (
          agent_id, session_key, session_id, session_file, channel,
          last_channel, last_to, last_account_id, last_thread_id,
          delivery_context_json, origin_json, display_name, group_name,
          model, department, created_at, updated_at, extra_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const [sessionKey, entry] of Object.entries(store)) {
        if (!entry) {
          continue;
        }
        const row = sessionEntryToRow(agentId, sessionKey, entry);
        insert.run(
          row.agent_id,
          row.session_key,
          row.session_id,
          row.session_file,
          row.channel,
          row.last_channel,
          row.last_to,
          row.last_account_id,
          row.last_thread_id,
          row.delivery_context_json,
          row.origin_json,
          row.display_name,
          row.group_name,
          row.model,
          row.department,
          row.created_at,
          row.updated_at,
          row.extra_json,
        );
      }

      conn.exec("COMMIT");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    // Table may not exist yet (e.g. tests without DB init).
    // Silently skip — same as failing to write to a missing directory.
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/** Upsert a single session entry. */
export function upsertSessionEntryInDb(
  agentId: string,
  sessionKey: string,
  entry: SessionEntry,
  db?: DatabaseSync,
): void {
  const conn = resolveDb(db);
  const row = sessionEntryToRow(agentId, sessionKey, entry);

  try {
    conn
      .prepare(
        `
      INSERT OR REPLACE INTO session_entries (
        agent_id, session_key, session_id, session_file, channel,
        last_channel, last_to, last_account_id, last_thread_id,
        delivery_context_json, origin_json, display_name, group_name,
        model, department, created_at, updated_at, extra_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        row.agent_id,
        row.session_key,
        row.session_id,
        row.session_file,
        row.channel,
        row.last_channel,
        row.last_to,
        row.last_account_id,
        row.last_thread_id,
        row.delivery_context_json,
        row.origin_json,
        row.display_name,
        row.group_name,
        row.model,
        row.department,
        row.created_at,
        row.updated_at,
        row.extra_json,
      );
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/** Delete a single session entry. */
export function deleteSessionEntryFromDb(
  agentId: string,
  sessionKey: string,
  db?: DatabaseSync,
): void {
  const conn = resolveDb(db);
  try {
    conn
      .prepare("DELETE FROM session_entries WHERE agent_id = ? AND session_key = ?")
      .run(agentId, sessionKey);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

/** Read a single entry's updatedAt without loading the full store. */
export function readSessionUpdatedAtFromDb(
  agentId: string,
  sessionKey: string,
  db?: DatabaseSync,
): number | undefined {
  const conn = resolveDb(db);
  try {
    // Try exact key first, then case-insensitive
    const normalizedKey = sessionKey.trim().toLowerCase();
    const row = conn
      .prepare(
        `SELECT updated_at FROM session_entries
         WHERE agent_id = ? AND (session_key = ? OR LOWER(session_key) = ?)
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(agentId, sessionKey.trim(), normalizedKey) as { updated_at: number | null } | undefined;
    return row?.updated_at ?? undefined;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return undefined;
    }
    throw err;
  }
}
