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

const OPENCLAW_STATE_SCHEMA_VERSION = 1;
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

type OpenClawStateMetadataDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "backup_runs" | "migration_runs" | "migration_sources"
>;

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

function ensureSchema(db: DatabaseSync): void {
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
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
  ensureSchema(db);
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
