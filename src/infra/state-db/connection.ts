import fs from "node:fs";
import path from "node:path";
/**
 * Singleton DatabaseSync connection for the operator1 state DB.
 *
 * Location: ~/.openclaw/operator1.db (respects OPENCLAW_STATE_DIR).
 * Uses WAL mode for concurrent reads from gateway, CLI, and agents.
 */
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const STATE_DB_FILENAME = "operator1.db";

let _db: DatabaseSync | null = null;

/** Resolve the path to the state DB file. */
export function getStateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), STATE_DB_FILENAME);
}

/**
 * Open (or return cached) singleton DatabaseSync connection.
 * Creates the DB file and parent directory on first access.
 * Sets WAL pragmas for safe concurrent access.
 */
export function getStateDb(env: NodeJS.ProcessEnv = process.env): DatabaseSync {
  if (_db) {
    return _db;
  }

  const dbPath = getStateDbPath(env);
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);

  // WAL pragmas — set on every open (per-connection state).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
  db.exec("PRAGMA foreign_keys = ON");

  _db = db;
  return db;
}

/** Close the singleton connection (clean shutdown). */
export function closeStateDb(): void {
  if (_db) {
    try {
      _db.close();
    } catch {
      // Ignore close errors (already closed, etc.)
    }
    _db = null;
  }
}

/**
 * Reset the cached singleton (for tests only).
 * Does NOT close the connection — caller is responsible for cleanup.
 */
export function resetStateDbCache(): void {
  _db = null;
}
