/**
 * SQLite-backed session store - hot index for session metadata.
 *
 * This replaces the flat sessions.json file that causes performance issues at scale.
 * Two-tier design:
 * - Hot index (SQLite): lightweight metadata table, indexed for fast queries
 * - Cold storage: existing .jsonl transcript files stay as-is (per-session)
 *
 * Related issues: #58534 (perf), #57497 (Postgres request)
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionEntry } from "./types.js";

const log = createSubsystemLogger("sessions/store-sqlite");

const SESSION_STORE_DIR_MODE = 0o700;
const SESSION_STORE_FILE_MODE = 0o600;
const SESSION_STORE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

/**
 * SQLite row type matching the sessions table schema.
 * Stores lightweight hot index metadata; complex fields serialized as JSON.
 */
type SessionRow = {
  session_key: string;
  session_id: string;
  updated_at: number | bigint;
  created_at: number | bigint | null;
  channel: string | null;
  last_channel: string | null;
  last_to: string | null;
  last_account_id: string | null;
  last_thread_id: string | null;
  label: string | null;
  display_name: string | null;
  status: string | null;
  model: string | null;
  model_provider: string | null;
  total_tokens: number | bigint | null;
  input_tokens: number | bigint | null;
  output_tokens: number | bigint | null;
  message_count: number | bigint | null;
  archived: number | null;
  /** Full SessionEntry JSON for fields not in dedicated columns */
  entry_json: string;
};

type SessionStatements = {
  selectAll: StatementSync;
  selectByKey: StatementSync;
  upsertRow: StatementSync;
  deleteRow: StatementSync;
  deleteOlderThan: StatementSync;
  countRows: StatementSync;
  selectOldestKeys: StatementSync;
  clearRows: StatementSync;
};

type SessionDatabase = {
  db: DatabaseSync;
  path: string;
  statements: SessionStatements;
};

let cachedDatabase: SessionDatabase | null = null;

function normalizeNumber(value: number | bigint | null | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function parseJsonValue<T>(raw: string | null | undefined): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/**
 * Convert SQLite row back to SessionEntry.
 * Merges indexed columns with the full JSON blob.
 */
function rowToSessionEntry(row: SessionRow): SessionEntry {
  const base = parseJsonValue<SessionEntry>(row.entry_json) ?? ({} as SessionEntry);

  // Overlay indexed columns (source of truth for hot fields)
  return {
    ...base,
    sessionId: row.session_id,
    updatedAt: normalizeNumber(row.updated_at) ?? Date.now(),
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.last_channel ? { lastChannel: row.last_channel as SessionEntry["lastChannel"] } : {}),
    ...(row.last_to ? { lastTo: row.last_to } : {}),
    ...(row.last_account_id ? { lastAccountId: row.last_account_id } : {}),
    ...(row.last_thread_id ? { lastThreadId: row.last_thread_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.status ? { status: row.status as SessionEntry["status"] } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.model_provider ? { modelProvider: row.model_provider } : {}),
    ...(normalizeNumber(row.total_tokens) != null
      ? { totalTokens: normalizeNumber(row.total_tokens) }
      : {}),
    ...(normalizeNumber(row.input_tokens) != null
      ? { inputTokens: normalizeNumber(row.input_tokens) }
      : {}),
    ...(normalizeNumber(row.output_tokens) != null
      ? { outputTokens: normalizeNumber(row.output_tokens) }
      : {}),
  };
}

/**
 * Bind SessionEntry to SQLite row parameters.
 */
function bindSessionEntry(
  sessionKey: string,
  entry: SessionEntry,
): Record<string, string | number | null> {
  return {
    session_key: sessionKey,
    session_id: entry.sessionId,
    updated_at: entry.updatedAt ?? Date.now(),
    created_at: entry.startedAt ?? null,
    channel: entry.channel ?? null,
    last_channel: entry.lastChannel ?? null,
    last_to: entry.lastTo ?? null,
    last_account_id: entry.lastAccountId ?? null,
    last_thread_id:
      entry.lastThreadId != null ? String(entry.lastThreadId) : null,
    label: entry.label ?? null,
    display_name: entry.displayName ?? null,
    status: entry.status ?? null,
    model: entry.model ?? null,
    model_provider: entry.modelProvider ?? null,
    total_tokens: entry.totalTokens ?? null,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
    message_count: null, // Reserved for future use
    archived: 0,
    entry_json: JSON.stringify(entry),
  };
}

function createStatements(db: DatabaseSync): SessionStatements {
  return {
    selectAll: db.prepare(`
      SELECT
        session_key,
        session_id,
        updated_at,
        created_at,
        channel,
        last_channel,
        last_to,
        last_account_id,
        last_thread_id,
        label,
        display_name,
        status,
        model,
        model_provider,
        total_tokens,
        input_tokens,
        output_tokens,
        message_count,
        archived,
        entry_json
      FROM sessions
      ORDER BY updated_at DESC
    `),
    selectByKey: db.prepare(`
      SELECT
        session_key,
        session_id,
        updated_at,
        created_at,
        channel,
        last_channel,
        last_to,
        last_account_id,
        last_thread_id,
        label,
        display_name,
        status,
        model,
        model_provider,
        total_tokens,
        input_tokens,
        output_tokens,
        message_count,
        archived,
        entry_json
      FROM sessions
      WHERE session_key = ?
    `),
    upsertRow: db.prepare(`
      INSERT INTO sessions (
        session_key,
        session_id,
        updated_at,
        created_at,
        channel,
        last_channel,
        last_to,
        last_account_id,
        last_thread_id,
        label,
        display_name,
        status,
        model,
        model_provider,
        total_tokens,
        input_tokens,
        output_tokens,
        message_count,
        archived,
        entry_json
      ) VALUES (
        @session_key,
        @session_id,
        @updated_at,
        @created_at,
        @channel,
        @last_channel,
        @last_to,
        @last_account_id,
        @last_thread_id,
        @label,
        @display_name,
        @status,
        @model,
        @model_provider,
        @total_tokens,
        @input_tokens,
        @output_tokens,
        @message_count,
        @archived,
        @entry_json
      )
      ON CONFLICT(session_key) DO UPDATE SET
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        created_at = excluded.created_at,
        channel = excluded.channel,
        last_channel = excluded.last_channel,
        last_to = excluded.last_to,
        last_account_id = excluded.last_account_id,
        last_thread_id = excluded.last_thread_id,
        label = excluded.label,
        display_name = excluded.display_name,
        status = excluded.status,
        model = excluded.model,
        model_provider = excluded.model_provider,
        total_tokens = excluded.total_tokens,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        message_count = excluded.message_count,
        archived = excluded.archived,
        entry_json = excluded.entry_json
    `),
    deleteRow: db.prepare(`DELETE FROM sessions WHERE session_key = ?`),
    deleteOlderThan: db.prepare(`DELETE FROM sessions WHERE updated_at < ?`),
    countRows: db.prepare(`SELECT COUNT(*) as count FROM sessions`),
    selectOldestKeys: db.prepare(`
      SELECT session_key FROM sessions
      ORDER BY updated_at ASC
      LIMIT ?
    `),
    clearRows: db.prepare(`DELETE FROM sessions`),
  };
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      created_at INTEGER,
      channel TEXT,
      last_channel TEXT,
      last_to TEXT,
      last_account_id TEXT,
      last_thread_id TEXT,
      label TEXT,
      display_name TEXT,
      status TEXT,
      model TEXT,
      model_provider TEXT,
      total_tokens INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      message_count INTEGER,
      archived INTEGER DEFAULT 0,
      entry_json TEXT NOT NULL
    );
  `);

  // Create indexes for common query patterns
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_channel ON sessions(channel);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_last_channel ON sessions(last_channel);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived);`);
}

function ensureSessionStorePermissions(pathname: string) {
  const dir = path.dirname(pathname);
  mkdirSync(dir, { recursive: true, mode: SESSION_STORE_DIR_MODE });
  chmodSync(dir, SESSION_STORE_DIR_MODE);
  for (const suffix of SESSION_STORE_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, SESSION_STORE_FILE_MODE);
  }
}

/**
 * Resolve the SQLite database path from the JSON store path.
 * sessions.json -> sessions.sqlite
 */
export function resolveSqlitePathFromJsonPath(jsonStorePath: string): string {
  const dir = path.dirname(jsonStorePath);
  const base = path.basename(jsonStorePath, ".json");
  return path.join(dir, `${base}.sqlite`);
}

/**
 * Open (or reuse) the SQLite session database.
 */
function openSessionDatabase(sqlitePath: string): SessionDatabase {
  if (cachedDatabase && cachedDatabase.path === sqlitePath) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    try {
      cachedDatabase.db.close();
    } catch {
      // Ignore close errors
    }
    cachedDatabase = null;
  }

  ensureSessionStorePermissions(sqlitePath);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(sqlitePath);

  // Configure for performance and durability
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA synchronous = NORMAL;`); // Balance between safety and speed
  db.exec(`PRAGMA busy_timeout = 5000;`);
  db.exec(`PRAGMA cache_size = -16000;`); // 16MB cache
  db.exec(`PRAGMA temp_store = MEMORY;`);

  ensureSchema(db);
  ensureSessionStorePermissions(sqlitePath);

  cachedDatabase = {
    db,
    path: sqlitePath,
    statements: createStatements(db),
  };
  return cachedDatabase;
}

/**
 * Close the cached database connection.
 * Useful for testing and cleanup.
 */
export function closeSessionDatabase(): void {
  if (cachedDatabase) {
    try {
      cachedDatabase.db.close();
    } catch {
      // Ignore close errors
    }
    cachedDatabase = null;
  }
}

/**
 * Load all sessions from SQLite store.
 * Returns the same Record<string, SessionEntry> format as the JSON store.
 */
export function loadSessionStoreSqlite(sqlitePath: string): Record<string, SessionEntry> {
  try {
    const { statements } = openSessionDatabase(sqlitePath);
    const rows = statements.selectAll.all() as SessionRow[];
    const store: Record<string, SessionEntry> = {};
    for (const row of rows) {
      store[row.session_key] = rowToSessionEntry(row);
    }
    return store;
  } catch (err) {
    throw err;
  }
}

/**
 * Get a single session entry by key.
 */
export function getSessionEntrySqlite(
  sqlitePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  try {
    const { statements } = openSessionDatabase(sqlitePath);
    const row = statements.selectByKey.get(sessionKey) as SessionRow | undefined;
    return row ? rowToSessionEntry(row) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Save all sessions to SQLite store.
 * Replaces all existing entries (full sync).
 */
export function saveSessionStoreSqlite(
  sqlitePath: string,
  store: Record<string, SessionEntry>,
): void {
  const { db, path: dbPath, statements } = openSessionDatabase(sqlitePath);

  db.exec("BEGIN IMMEDIATE");
  try {
    statements.clearRows.run();
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (!entry) continue;
      statements.upsertRow.run(bindSessionEntry(sessionKey, entry));
    }
    db.exec("COMMIT");
    ensureSessionStorePermissions(dbPath);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Upsert a single session entry.
 */
export function upsertSessionEntrySqlite(
  sqlitePath: string,
  sessionKey: string,
  entry: SessionEntry,
): void {
  const { path: dbPath, statements } = openSessionDatabase(sqlitePath);
  statements.upsertRow.run(bindSessionEntry(sessionKey, entry));
  ensureSessionStorePermissions(dbPath);
}

/**
 * Delete a single session entry.
 */
export function deleteSessionEntrySqlite(sqlitePath: string, sessionKey: string): void {
  const { path: dbPath, statements } = openSessionDatabase(sqlitePath);
  statements.deleteRow.run(sessionKey);
  ensureSessionStorePermissions(dbPath);
}

/**
 * Prune sessions older than the given timestamp.
 * Returns the number of deleted entries.
 */
export function pruneSessionsOlderThanSqlite(
  sqlitePath: string,
  olderThanMs: number,
): number {
  const { db, path: dbPath, statements } = openSessionDatabase(sqlitePath);
  const cutoff = Date.now() - olderThanMs;

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = statements.deleteOlderThan.run(cutoff);
    db.exec("COMMIT");
    ensureSessionStorePermissions(dbPath);
    return typeof result.changes === "number" ? result.changes : 0;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Cap the number of session entries.
 * Removes oldest entries exceeding maxEntries.
 * Returns the number of deleted entries.
 */
export function capSessionEntriesSqlite(sqlitePath: string, maxEntries: number): number {
  const { db, path: dbPath, statements } = openSessionDatabase(sqlitePath);

  const countResult = statements.countRows.get() as { count: number | bigint };
  const currentCount =
    typeof countResult.count === "bigint"
      ? Number(countResult.count)
      : countResult.count;

  if (currentCount <= maxEntries) {
    return 0;
  }

  const toDelete = currentCount - maxEntries;
  const oldestRows = statements.selectOldestKeys.all(toDelete) as Array<{
    session_key: string;
  }>;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of oldestRows) {
      statements.deleteRow.run(row.session_key);
    }
    db.exec("COMMIT");
    ensureSessionStorePermissions(dbPath);
    return oldestRows.length;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Get the count of sessions in the store.
 */
export function getSessionCountSqlite(sqlitePath: string): number {
  try {
    const { statements } = openSessionDatabase(sqlitePath);
    const result = statements.countRows.get() as { count: number | bigint };
    return typeof result.count === "bigint" ? Number(result.count) : result.count;
  } catch {
    return 0;
  }
}

/**
 * Check if SQLite store exists and is valid.
 */
export function sqliteStoreExists(sqlitePath: string): boolean {
  return existsSync(sqlitePath);
}

/**
 * Migrate sessions from JSON file to SQLite.
 * Returns the number of migrated entries.
 */
export function migrateJsonToSqlite(jsonStorePath: string, sqlitePath: string): number {
  if (!existsSync(jsonStorePath)) {
    log.debug("no JSON store to migrate", { jsonStorePath });
    return 0;
  }

  try {
    const raw = readFileSync(jsonStorePath, "utf-8");
    if (!raw.trim()) {
      return 0;
    }

    const store = JSON.parse(raw) as Record<string, SessionEntry>;
    if (!store || typeof store !== "object" || Array.isArray(store)) {
      return 0;
    }

    const entries = Object.entries(store).filter(([, entry]) => entry != null);
    if (entries.length === 0) {
      return 0;
    }

    const { db, path: dbPath, statements } = openSessionDatabase(sqlitePath);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [sessionKey, entry] of entries) {
        statements.upsertRow.run(bindSessionEntry(sessionKey, entry));
      }
      db.exec("COMMIT");
      ensureSessionStorePermissions(dbPath);
      log.info("migrated sessions from JSON to SQLite", {
        count: entries.length,
        from: jsonStorePath,
        to: sqlitePath,
      });
      return entries.length;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } catch (err) {
    log.error("failed to migrate JSON to SQLite", { error: err });
    return 0;
  }
}

/**
 * Reset the cached database for testing.
 */
export function resetSessionDatabaseForTest(): void {
  closeSessionDatabase();
}
