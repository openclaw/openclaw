import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawStateSqliteDir,
  resolveOpenClawStateSqlitePath,
} from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.generated.js";

const OPENCLAW_STATE_SCHEMA_VERSION = 18;
export const OPENCLAW_SQLITE_BUSY_TIMEOUT_MS = 30_000;
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

export type OpenClawMigrationRunStatus = "completed" | "warning" | "failed";
export type OpenClawBackupRunStatus = "completed" | "failed";

export type RecordOpenClawStateMigrationRunOptions = OpenClawStateDatabaseOptions & {
  id?: string;
  startedAt: number;
  finishedAt?: number;
  status: OpenClawMigrationRunStatus;
  sourceVersion?: number;
  targetVersion?: number;
  report: Record<string, unknown>;
};

export type RecordOpenClawStateMigrationSourceOptions = OpenClawStateDatabaseOptions & {
  runId: string;
  migrationKind: string;
  sourceKey: string;
  sourcePath: string;
  targetTable: string;
  status: OpenClawMigrationRunStatus;
  importedAt: number;
  removedSource: boolean;
  sourceSha256?: string;
  sourceSizeBytes?: number;
  sourceRecordCount?: number;
  report: Record<string, unknown>;
};

export type RecordOpenClawStateBackupRunOptions = OpenClawStateDatabaseOptions & {
  id?: string;
  createdAt: number;
  archivePath: string;
  status: OpenClawBackupRunStatus;
  manifest: Record<string, unknown>;
};

let cachedDatabase: OpenClawStateDatabase | null = null;

type UserVersionRow = {
  user_version?: number | bigint;
};

type OpenClawStateMetadataDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "backup_runs" | "migration_runs" | "migration_sources"
>;

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  const raw = row?.user_version ?? 0;
  return typeof raw === "bigint" ? Number(raw) : raw;
}

function ensureOpenClawStatePermissions(pathname: string, env: NodeJS.ProcessEnv): void {
  const dir = path.dirname(pathname);
  const defaultDir = resolveOpenClawStateSqliteDir(env);
  const isDefaultStateDatabase =
    path.resolve(pathname) === path.resolve(resolveOpenClawStateSqlitePath(env));
  if (isDefaultStateDatabase && dir !== defaultDir) {
    throw new Error(`OpenClaw state database path resolved outside its state dir: ${pathname}`);
  }
  const dirExisted = existsSync(dir);
  mkdirSync(dir, { recursive: true, mode: OPENCLAW_STATE_DIR_MODE });
  if (isDefaultStateDatabase || !dirExisted) {
    chmodSync(dir, OPENCLAW_STATE_DIR_MODE);
  }
  for (const suffix of OPENCLAW_STATE_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (existsSync(candidate)) {
      chmodSync(candidate, OPENCLAW_STATE_FILE_MODE);
    }
  }
}

function tableHasColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`).all() as Array<{
    name?: unknown;
  }>;
  return rows.some((row) => row.name === columnName);
}

function rebuildTaskDeliveryStateWithForeignKey(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_delivery_state_next (
      task_id TEXT NOT NULL PRIMARY KEY,
      requester_origin_json TEXT,
      last_notified_event_at INTEGER,
      FOREIGN KEY (task_id) REFERENCES task_runs(task_id) ON DELETE CASCADE
    );
    INSERT OR REPLACE INTO task_delivery_state_next (
      task_id,
      requester_origin_json,
      last_notified_event_at
    )
    SELECT
      task_delivery_state.task_id,
      task_delivery_state.requester_origin_json,
      task_delivery_state.last_notified_event_at
    FROM task_delivery_state
    WHERE EXISTS (
      SELECT 1
      FROM task_runs
      WHERE task_runs.task_id = task_delivery_state.task_id
    );
    DROP TABLE task_delivery_state;
    ALTER TABLE task_delivery_state_next RENAME TO task_delivery_state;
  `);
}

function migrateStateSchema(db: DatabaseSync, fromVersion: number): void {
  if (fromVersion < 13) {
    if (!tableHasColumn(db, "cron_jobs", "sort_order")) {
      db.exec("ALTER TABLE cron_jobs ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;");
    }
    db.exec(`
      DROP INDEX IF EXISTS idx_cron_jobs_store_updated;
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_store_updated
        ON cron_jobs(store_key, sort_order ASC, updated_at DESC, job_id);
    `);
  }
  if (fromVersion < 14) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transcript_files_path_updated
        ON transcript_files(path, imported_at DESC, exported_at DESC, agent_id, session_id);
      CREATE INDEX IF NOT EXISTS idx_transcript_files_session_updated
        ON transcript_files(agent_id, session_id, imported_at DESC, exported_at DESC, path);
    `);
  }
  if (fromVersion < 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS migration_sources (
        source_key TEXT NOT NULL PRIMARY KEY,
        migration_kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_table TEXT NOT NULL,
        source_sha256 TEXT,
        source_size_bytes INTEGER,
        source_record_count INTEGER,
        last_run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        imported_at INTEGER NOT NULL,
        removed_source INTEGER NOT NULL DEFAULT 0,
        report_json TEXT NOT NULL,
        FOREIGN KEY (last_run_id) REFERENCES migration_runs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_migration_sources_path
        ON migration_sources(source_path, migration_kind, target_table);
      CREATE INDEX IF NOT EXISTS idx_migration_sources_run
        ON migration_sources(last_run_id, source_path);
    `);
  }
  if (fromVersion < 16) {
    rebuildTaskDeliveryStateWithForeignKey(db);
  }
}

function ensureSchema(db: DatabaseSync, pathname: string): void {
  const userVersion = getUserVersion(db);
  if (userVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw state database schema version ${userVersion} is newer than supported version ${OPENCLAW_STATE_SCHEMA_VERSION}: ${pathname}`,
    );
  }

  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  migrateStateSchema(db, userVersion);
  db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
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
    clearNodeSqliteKyselyCacheForDatabase(cachedDatabase.db);
    cachedDatabase.db.close();
    cachedDatabase = null;
  }

  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = configureSqliteWalMaintenance(db, {
    databaseLabel: "openclaw-state",
    databasePath: pathname,
  });
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA foreign_keys = ON;");
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
  const result = runSqliteImmediateTransactionSync(database.db, () => operation(database));
  ensureOpenClawStatePermissions(database.path, options.env ?? process.env);
  return result;
}

export function recordOpenClawStateMigrationRun(
  options: RecordOpenClawStateMigrationRunOptions,
): string {
  const id = options.id ?? randomUUID();
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("migration_runs").values({
        id,
        started_at: options.startedAt,
        finished_at: options.finishedAt ?? null,
        status: options.status,
        source_version: options.sourceVersion ?? null,
        target_version: options.targetVersion ?? OPENCLAW_STATE_SCHEMA_VERSION,
        report_json: JSON.stringify(options.report),
      }),
    );
  }, options);
  return id;
}

export function recordOpenClawStateMigrationSource(
  options: RecordOpenClawStateMigrationSourceOptions,
): void {
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("migration_sources")
        .values({
          source_key: options.sourceKey,
          migration_kind: options.migrationKind,
          source_path: options.sourcePath,
          target_table: options.targetTable,
          source_sha256: options.sourceSha256 ?? null,
          source_size_bytes: options.sourceSizeBytes ?? null,
          source_record_count: options.sourceRecordCount ?? null,
          last_run_id: options.runId,
          status: options.status,
          imported_at: options.importedAt,
          removed_source: options.removedSource ? 1 : 0,
          report_json: JSON.stringify(options.report),
        })
        .onConflict((conflict) =>
          conflict.column("source_key").doUpdateSet({
            migration_kind: (eb) => eb.ref("excluded.migration_kind"),
            source_path: (eb) => eb.ref("excluded.source_path"),
            target_table: (eb) => eb.ref("excluded.target_table"),
            source_sha256: (eb) => eb.ref("excluded.source_sha256"),
            source_size_bytes: (eb) => eb.ref("excluded.source_size_bytes"),
            source_record_count: (eb) => eb.ref("excluded.source_record_count"),
            last_run_id: (eb) => eb.ref("excluded.last_run_id"),
            status: (eb) => eb.ref("excluded.status"),
            imported_at: (eb) => eb.ref("excluded.imported_at"),
            removed_source: (eb) => eb.ref("excluded.removed_source"),
            report_json: (eb) => eb.ref("excluded.report_json"),
          }),
        ),
    );
  }, options);
}

export function recordOpenClawStateBackupRun(options: RecordOpenClawStateBackupRunOptions): string {
  const id = options.id ?? randomUUID();
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<OpenClawStateMetadataDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db.insertInto("backup_runs").values({
        id,
        created_at: options.createdAt,
        archive_path: options.archivePath,
        status: options.status,
        manifest_json: JSON.stringify(options.manifest),
      }),
    );
  }, options);
  return id;
}

export function closeOpenClawStateDatabaseForTest(): void {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.walMaintenance.close();
  clearNodeSqliteKyselyCacheForDatabase(cachedDatabase.db);
  cachedDatabase.db.close();
  cachedDatabase = null;
}
