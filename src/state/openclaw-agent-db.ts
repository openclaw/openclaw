// OpenClaw agent database stores agent-scoped persisted runtime state.
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  configureSqliteConnectionPragmas,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
export { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";

/**
 * Per-agent SQLite database lifecycle and shared-state registration.
 *
 * Each opened agent database is schema-owned by one normalized agent id, cached
 * per pathname, protected with private file modes, and registered in the shared
 * OpenClaw state database for discovery and maintenance.
 */
// The QMD export cache table is disposable derived state, so adding it must not
// stamp agent DBs with a newer user_version that prevents rollback to schema-1
// builds. Future persistent user-state migrations should bump this version.
const OPENCLAW_AGENT_SCHEMA_VERSION = 1;
const OPENCLAW_AGENT_DB_DIR_MODE = 0o700;
const OPENCLAW_AGENT_DB_FILE_MODE = 0o600;

/** Open per-agent SQLite database handle plus lifecycle maintenance. */
export type OpenClawAgentDatabase = {
  agentId: string;
  db: DatabaseSync;
  path: string;
  walMaintenance: SqliteWalMaintenance;
};

/** Options for resolving and opening one agent database. */
export type OpenClawAgentDatabaseOptions = OpenClawStateDatabaseOptions & {
  agentId: string;
};

type OpenClawAgentMetadataDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;
type OpenClawAgentQmdExportCacheDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "qmd_session_export_cache"
>;
type OpenClawAgentRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "agent_databases">;

const cachedDatabases = new Map<string, OpenClawAgentDatabase>();

/** Options for QMD's per-agent session export cache. */
export type QmdSessionExportCacheOptions = {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  path?: string;
};

/** Cache key for one exported session markdown target. */
export type QmdSessionExportCacheKey = {
  exportDir: string;
  renderVersion: number;
  sessionFile: string;
};

/** Persisted QMD session export cache row, exposed without raw DB access. */
export type QmdSessionExportCacheEntry = QmdSessionExportCacheKey & {
  contentFingerprint: string;
  hash: string;
  ino: number;
  mtimeMs: number;
  size: number;
  target: string;
  // SHA-1 of the rendered export markdown bytes. Null for rows written before
  // the column existed; callers treat null as "unknown" and rebuild once to
  // repopulate it rather than trusting the on-disk target's bytes.
  targetFingerprint: string | null;
  updatedAt: number;
};

export type UpsertQmdSessionExportCacheEntry = QmdSessionExportCacheEntry;

function toQmdSessionExportCacheEntry(
  row: OpenClawAgentKyselyDatabase["qmd_session_export_cache"],
): QmdSessionExportCacheEntry {
  return {
    sessionFile: row.session_file,
    exportDir: row.export_dir,
    renderVersion: row.render_version,
    size: row.size,
    mtimeMs: row.mtime_ms,
    ino: row.ino,
    contentFingerprint: row.content_fingerprint,
    hash: row.hash,
    target: row.target,
    targetFingerprint: row.target_fingerprint,
    updatedAt: row.updated_at,
  };
}

type ExistingSchemaMeta = {
  agentId: string | null;
  role: string | null;
};

function assertSupportedAgentSchemaVersion(db: DatabaseSync, pathname: string): void {
  const userVersion = readSqliteUserVersion(db);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${pathname} uses newer schema version ${userVersion}; this OpenClaw build supports ${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
    );
  }
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === columnName);
}

/**
 * Add a nullable column to an existing agent table if it is missing.
 *
 * `CREATE TABLE IF NOT EXISTS` never alters an already-created table, so a new
 * column must be backfilled via ALTER for agent DBs created by an older build.
 * The migration is additive and nullable only, so it stays within schema
 * `user_version` 1 (no rollback hazard) — old rows simply read the new column
 * back as NULL until they are next rewritten.
 */
function ensureAgentTableColumn(db: DatabaseSync, tableName: string, columnSql: string): void {
  const columnName = columnSql.trim().split(/\s+/, 1)[0];
  if (!columnName || tableHasColumn(db, tableName, columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnSql};`);
}

function ensureOpenClawAgentDatabasePermissions(
  pathname: string,
  options: OpenClawAgentDatabaseOptions,
): void {
  const dir = path.dirname(pathname);
  const defaultPath = resolveOpenClawAgentSqlitePath({
    agentId: options.agentId,
    env: options.env,
  });
  const isDefaultAgentDatabase = path.resolve(pathname) === path.resolve(defaultPath);
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_AGENT_DB_DIR_MODE });
  // Default agent state is private by contract; custom pre-existing dirs keep caller ownership.
  if (isDefaultAgentDatabase || !dirExisted) {
    chmodSync(dir, OPENCLAW_AGENT_DB_DIR_MODE);
  }
  for (const candidate of resolveSqliteDatabaseFilePaths(pathname)) {
    if (existsSync(candidate)) {
      chmodSync(candidate, OPENCLAW_AGENT_DB_FILE_MODE);
    }
  }
}

function readExistingSchemaMeta(db: DatabaseSync): ExistingSchemaMeta | null {
  const schemaMetaTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (!schemaMetaTable) {
    return null;
  }
  const row = db
    .prepare("SELECT role, agent_id FROM schema_meta WHERE meta_key = 'primary'")
    .get() as { agent_id?: unknown; role?: unknown } | undefined;
  if (!row) {
    return null;
  }
  return {
    agentId: typeof row.agent_id === "string" ? row.agent_id : null,
    role: typeof row.role === "string" ? row.role : null,
  };
}

function assertExistingSchemaOwner(
  existing: ExistingSchemaMeta | null,
  agentId: string,
  pathname: string,
): void {
  if (!existing) {
    return;
  }
  // Agent DB files are not interchangeable; opening another role/id would corrupt ownership.
  if (existing.role !== "agent") {
    throw new Error(
      `OpenClaw agent database ${pathname} has schema role ${existing.role ?? "unknown"}; expected agent.`,
    );
  }
  if (!existing.agentId) {
    throw new Error(`OpenClaw agent database ${pathname} has no agent owner.`);
  }
  if (normalizeAgentId(existing.agentId) !== agentId) {
    throw new Error(
      `OpenClaw agent database ${pathname} belongs to agent ${existing.agentId}; requested agent ${agentId}.`,
    );
  }
}

function ensureAgentSchema(db: DatabaseSync, agentId: string, pathname: string): void {
  assertSupportedAgentSchemaVersion(db, pathname);
  assertExistingSchemaOwner(readExistingSchemaMeta(db), agentId, pathname);
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  // Additive, nullable backfill for agent DBs created before the column existed.
  ensureAgentTableColumn(db, "qmd_session_export_cache", "target_fingerprint TEXT");
  const kysely = getNodeSqliteKysely<OpenClawAgentMetadataDatabase>(db);
  db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("schema_meta")
      .values({
        meta_key: "primary",
        role: "agent",
        schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        agent_id: agentId,
        app_version: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("meta_key").doUpdateSet({
          role: "agent",
          schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
          agent_id: agentId,
          app_version: null,
          updated_at: now,
        }),
      ),
  );
}

/** Initialize agent schema/ownership metadata on an independently managed connection. */
export function ensureOpenClawAgentDatabaseSchema(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & { register?: boolean },
): void {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  ensureAgentSchema(db, agentId, pathname);
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  if (options.register === true) {
    registerAgentDatabase({ agentId, path: pathname, env: options.env });
  }
}

function registerAgentDatabase(params: {
  agentId: string;
  path: string;
  env?: NodeJS.ProcessEnv;
}): void {
  let sizeBytes: number | null = null;
  try {
    sizeBytes = statSync(params.path).size;
  } catch {
    sizeBytes = null;
  }
  const lastSeenAt = Date.now();
  runOpenClawStateWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<OpenClawAgentRegistryDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .insertInto("agent_databases")
          .values({
            agent_id: params.agentId,
            path: params.path,
            schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
            last_seen_at: lastSeenAt,
            size_bytes: sizeBytes,
          })
          .onConflict((conflict) =>
            conflict.columns(["agent_id", "path"]).doUpdateSet({
              schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
              last_seen_at: lastSeenAt,
              size_bytes: sizeBytes,
            }),
          ),
      );
    },
    { env: params.env },
  );
}

/** Open or return a cached per-agent database after schema and owner validation. */
export function openOpenClawAgentDatabase(
  options: OpenClawAgentDatabaseOptions,
): OpenClawAgentDatabase {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  const cached = cachedDatabases.get(pathname);
  if (cached?.db.isOpen) {
    if (cached.agentId !== agentId) {
      throw new Error(
        `OpenClaw agent database ${pathname} is already open for agent ${cached.agentId}; requested agent ${agentId}.`,
      );
    }
    registerAgentDatabase({ agentId, path: pathname, env: options.env });
    return cached;
  }
  if (cached) {
    // A closed handle can leave Kysely and WAL helpers cached; clear both before reopening.
    cached.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(cached.db);
    cachedDatabases.delete(pathname);
  }

  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = (() => {
    let maintenance: SqliteWalMaintenance | undefined;
    try {
      maintenance = configureSqliteConnectionPragmas(db, {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: `openclaw-agent:${agentId}`,
        databasePath: pathname,
        foreignKeys: true,
        synchronous: "NORMAL",
      });
      ensureAgentSchema(db, agentId, pathname);
      return maintenance;
    } catch (err) {
      maintenance?.close();
      db.close();
      throw err;
    }
  })();
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const database = { agentId, db, path: pathname, walMaintenance };
  cachedDatabases.set(pathname, database);
  registerAgentDatabase({ agentId, path: pathname, env: options.env });
  return database;
}

/** Run a synchronous immediate transaction against an agent database. */
export function runOpenClawAgentWriteTransaction<T>(
  operation: (database: OpenClawAgentDatabase) => T,
  options: OpenClawAgentDatabaseOptions,
): T {
  const database = openOpenClawAgentDatabase(options);
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database));
  ensureOpenClawAgentDatabasePermissions(database.path, options);
  return result;
}

/** Read one QMD session export cache row for a normalized agent database. */
export function readQmdSessionExportCacheEntry(
  options: QmdSessionExportCacheOptions,
  key: QmdSessionExportCacheKey,
): QmdSessionExportCacheEntry | null {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<OpenClawAgentQmdExportCacheDatabase>(database.db);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("qmd_session_export_cache")
      .selectAll()
      .where("session_file", "=", key.sessionFile)
      .where("export_dir", "=", key.exportDir)
      .where("render_version", "=", key.renderVersion),
  );
  return row ? toQmdSessionExportCacheEntry(row) : null;
}

/** Upsert QMD's per-agent session export cache without exposing the raw DB. */
export function upsertQmdSessionExportCacheEntry(
  options: QmdSessionExportCacheOptions,
  entry: UpsertQmdSessionExportCacheEntry,
): void {
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawAgentQmdExportCacheDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("qmd_session_export_cache")
        .values({
          session_file: entry.sessionFile,
          export_dir: entry.exportDir,
          render_version: entry.renderVersion,
          size: entry.size,
          mtime_ms: entry.mtimeMs,
          ino: entry.ino,
          content_fingerprint: entry.contentFingerprint,
          hash: entry.hash,
          target: entry.target,
          target_fingerprint: entry.targetFingerprint,
          updated_at: entry.updatedAt,
        })
        .onConflict((conflict) =>
          conflict.columns(["session_file", "export_dir", "render_version"]).doUpdateSet({
            size: entry.size,
            mtime_ms: entry.mtimeMs,
            ino: entry.ino,
            content_fingerprint: entry.contentFingerprint,
            hash: entry.hash,
            target: entry.target,
            target_fingerprint: entry.targetFingerprint,
            updated_at: entry.updatedAt,
          }),
        ),
    );
  }, options);
}

/** List cached rows for one QMD export target scope. */
export function listQmdSessionExportCacheEntries(
  options: QmdSessionExportCacheOptions,
  key: Pick<QmdSessionExportCacheKey, "exportDir" | "renderVersion">,
): QmdSessionExportCacheEntry[] {
  const database = openOpenClawAgentDatabase(options);
  const db = getNodeSqliteKysely<OpenClawAgentQmdExportCacheDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("qmd_session_export_cache")
      .selectAll()
      .where("export_dir", "=", key.exportDir)
      .where("render_version", "=", key.renderVersion),
  ).rows.map(toQmdSessionExportCacheEntry);
}

/** Delete specific QMD session export cache rows for one export target scope. */
export function deleteQmdSessionExportCacheEntries(
  options: QmdSessionExportCacheOptions,
  params: Pick<QmdSessionExportCacheKey, "exportDir" | "renderVersion"> & {
    sessionFiles: readonly string[];
  },
): void {
  if (params.sessionFiles.length === 0) {
    return;
  }
  runOpenClawAgentWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawAgentQmdExportCacheDatabase>(database.db);
    for (const sessionFile of params.sessionFiles) {
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("qmd_session_export_cache")
          .where("session_file", "=", sessionFile)
          .where("export_dir", "=", params.exportDir)
          .where("render_version", "=", params.renderVersion),
      );
    }
  }, options);
}

/** Close cached agent databases so tests can remove temp dirs and reopen cleanly. */
export function closeOpenClawAgentDatabasesForTest(): void {
  for (const database of cachedDatabases.values()) {
    database.walMaintenance.close();
    clearNodeSqliteKyselyCacheForDatabase(database.db);
    database.db.close();
  }
  cachedDatabases.clear();
}
