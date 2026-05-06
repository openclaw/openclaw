import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";

const OPENCLAW_STATE_SCHEMA_VERSION = 1;
const OPENCLAW_STATE_DIR_MODE = 0o700;
const OPENCLAW_STATE_FILE_MODE = 0o600;
const OPENCLAW_STATE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

export type OpenClawStateDatabase = {
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

export type OpenClawStateDatabaseOptions = {
  env?: NodeJS.ProcessEnv;
  path?: string;
};

let cachedDatabase: OpenClawStateDatabase | null = null;

type UserVersionRow = {
  user_version?: number | bigint;
};

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  const raw = row?.user_version ?? 0;
  return typeof raw === "bigint" ? Number(raw) : raw;
}

function ensureOpenClawStatePermissions(pathname: string, env: NodeJS.ProcessEnv): void {
  const dir = path.dirname(pathname);
  const defaultDir = resolveOpenClawStateSqliteDir(env);
  if (pathname === resolveOpenClawStateSqlitePath(env) && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
  }
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_STATE_DIR_MODE });
  chmodSync(dir, OPENCLAW_STATE_DIR_MODE);
  for (const suffix of OPENCLAW_STATE_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, OPENCLAW_STATE_FILE_MODE);
    }
  }
}

function ensureSchema(db: DatabaseSync, pathname: string): void {
  const userVersion = getUserVersion(db);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw state database schema version ${userVersion} is newer than supported version ${OPENCLAW_STATE_SCHEMA_VERSION}: ${pathname}`,
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (
      scope      TEXT NOT NULL,
      key        TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id    TEXT PRIMARY KEY,
      config_json TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_entries (
      agent_id    TEXT NOT NULL,
      session_key TEXT NOT NULL,
      entry_json  TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (agent_id, session_key)
    );

    CREATE INDEX IF NOT EXISTS idx_session_entries_updated_at
      ON session_entries(agent_id, updated_at DESC, session_key);

    CREATE TABLE IF NOT EXISTS transcript_events (
      agent_id   TEXT NOT NULL,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, session_id, seq)
    );

    CREATE TABLE IF NOT EXISTS transcript_files (
      agent_id    TEXT NOT NULL,
      session_id  TEXT NOT NULL,
      path        TEXT NOT NULL,
      imported_at INTEGER,
      exported_at INTEGER,
      PRIMARY KEY (agent_id, session_id, path)
    );

    CREATE TABLE IF NOT EXISTS vfs_entries (
      agent_id      TEXT NOT NULL,
      namespace     TEXT NOT NULL,
      path          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      content_blob  BLOB,
      metadata_json TEXT NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (agent_id, namespace, path)
    );

    CREATE INDEX IF NOT EXISTS idx_vfs_entries_namespace
      ON vfs_entries(agent_id, namespace, kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS tool_artifacts (
      agent_id      TEXT NOT NULL,
      run_id        TEXT NOT NULL,
      artifact_id   TEXT NOT NULL,
      kind          TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      blob          BLOB,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (agent_id, run_id, artifact_id)
    );

    PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};
  `);
}

function resolveDatabasePath(options: OpenClawStateDatabaseOptions = {}): string {
  return options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env);
}

export function openOpenClawStateDatabase(
  options: OpenClawStateDatabaseOptions = {},
): OpenClawStateDatabase {
  const env = options.env ?? process.env;
  const pathname = resolveDatabasePath(options);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.walMaintenance.close();
    cachedDatabase.db.close();
    cachedDatabase = null;
  }

  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = configureSqliteWalMaintenance(db);
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  ensureSchema(db, pathname);
  ensureOpenClawStatePermissions(pathname, env);
  cachedDatabase = { db, path: pathname, walMaintenance };
  return cachedDatabase;
}

export function runOpenClawStateWriteTransaction<T>(
  operation: (database: OpenClawStateDatabase) => T,
  options: OpenClawStateDatabaseOptions = {},
): T {
  const database = openOpenClawStateDatabase(options);
  database.db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation(database);
    database.db.exec("COMMIT");
    ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
    return result;
  } catch (error) {
    try {
      database.db.exec("ROLLBACK");
    } catch {
      // Preserve the original error; rollback failure is secondary.
    }
    throw error;
  }
}

export function closeOpenClawStateDatabaseForTest(): void {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.walMaintenance.close();
  cachedDatabase.db.close();
  cachedDatabase = null;
}
