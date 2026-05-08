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

const OPENCLAW_STATE_SCHEMA_VERSION = 21;
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

function migrateCronJobRuntimeStateColumns(db: DatabaseSync): void {
  if (!tableHasColumn(db, "cron_jobs", "state_json")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}';");
  }
  if (!tableHasColumn(db, "cron_jobs", "runtime_updated_at_ms")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN runtime_updated_at_ms INTEGER;");
  }
  if (!tableHasColumn(db, "cron_jobs", "schedule_identity")) {
    db.exec("ALTER TABLE cron_jobs ADD COLUMN schedule_identity TEXT;");
  }

  const legacyRows = db
    .prepare("SELECT key, value_json FROM kv WHERE scope = 'cron.jobs.state'")
    .all() as Array<{ key?: unknown; value_json?: unknown }>;
  if (legacyRows.length === 0) {
    return;
  }

  const update = db.prepare(`
    UPDATE cron_jobs
    SET
      state_json = ?,
      runtime_updated_at_ms = ?,
      schedule_identity = ?,
      updated_at = max(updated_at, ?)
    WHERE store_key = ?
      AND job_id = ?
  `);
  const now = Date.now();
  for (const row of legacyRows) {
    if (typeof row.key !== "string" || typeof row.value_json !== "string") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const jobs = (parsed as { jobs?: unknown }).jobs;
    if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
      continue;
    }
    for (const [jobId, entry] of Object.entries(jobs)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const record = entry as {
        scheduleIdentity?: unknown;
        state?: unknown;
        updatedAtMs?: unknown;
      };
      const state =
        record.state && typeof record.state === "object" && !Array.isArray(record.state)
          ? record.state
          : {};
      update.run(
        JSON.stringify(state),
        typeof record.updatedAtMs === "number" && Number.isFinite(record.updatedAtMs)
          ? record.updatedAtMs
          : null,
        typeof record.scheduleIdentity === "string" ? record.scheduleIdentity : null,
        now,
        row.key,
        jobId,
      );
    }
  }

  db.prepare("DELETE FROM kv WHERE scope = 'cron.jobs.state'").run();
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBooleanInteger(value: unknown): number | null {
  return typeof value === "boolean" ? (value ? 1 : 0) : null;
}

function readJsonText(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function migrateSubagentRunsFromKv(db: DatabaseSync): void {
  const legacyRows = db
    .prepare("SELECT key, value_json FROM kv WHERE scope = 'subagent_runs'")
    .all() as Array<{ key?: unknown; value_json?: unknown }>;
  if (legacyRows.length === 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO subagent_runs (
      run_id,
      child_session_key,
      controller_session_key,
      requester_session_key,
      requester_display_key,
      requester_origin_json,
      task,
      cleanup,
      label,
      model,
      agent_dir,
      workspace_dir,
      run_timeout_seconds,
      spawn_mode,
      created_at,
      started_at,
      session_started_at,
      accumulated_runtime_ms,
      ended_at,
      outcome_json,
      archive_at_ms,
      cleanup_completed_at,
      cleanup_handled,
      suppress_announce_reason,
      expects_completion_message,
      announce_retry_count,
      last_announce_retry_at,
      last_announce_delivery_error,
      ended_reason,
      pause_reason,
      wake_on_descendant_settle,
      frozen_result_text,
      frozen_result_captured_at,
      fallback_frozen_result_text,
      fallback_frozen_result_captured_at,
      ended_hook_emitted_at,
      pending_final_delivery,
      pending_final_delivery_created_at,
      pending_final_delivery_last_attempt_at,
      pending_final_delivery_attempt_count,
      pending_final_delivery_last_error,
      pending_final_delivery_payload_json,
      completion_announced_at,
      attachments_dir,
      attachments_root_dir,
      retain_attachments_on_keep,
      payload_json
    )
    VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);

  for (const row of legacyRows) {
    if (typeof row.key !== "string" || typeof row.value_json !== "string") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const runId = readString(record.runId) ?? row.key.trim();
    const childSessionKey = readString(record.childSessionKey);
    const requesterSessionKey = readString(record.requesterSessionKey);
    if (!runId || !childSessionKey || !requesterSessionKey) {
      continue;
    }
    insert.run(
      runId,
      childSessionKey,
      readString(record.controllerSessionKey) ?? requesterSessionKey,
      requesterSessionKey,
      readString(record.requesterDisplayKey) ?? "",
      readJsonText(record.requesterOrigin),
      readString(record.task) ?? "",
      record.cleanup === "delete" ? "delete" : "keep",
      readString(record.label),
      readString(record.model),
      readString(record.agentDir),
      readString(record.workspaceDir),
      readFiniteNumber(record.runTimeoutSeconds),
      record.spawnMode === "session" ? "session" : "run",
      readFiniteNumber(record.createdAt) ?? Date.now(),
      readFiniteNumber(record.startedAt),
      readFiniteNumber(record.sessionStartedAt),
      readFiniteNumber(record.accumulatedRuntimeMs),
      readFiniteNumber(record.endedAt),
      readJsonText(record.outcome),
      readFiniteNumber(record.archiveAtMs),
      readFiniteNumber(record.cleanupCompletedAt),
      readBooleanInteger(record.cleanupHandled),
      readString(record.suppressAnnounceReason),
      readBooleanInteger(record.expectsCompletionMessage),
      readFiniteNumber(record.announceRetryCount),
      readFiniteNumber(record.lastAnnounceRetryAt),
      readString(record.lastAnnounceDeliveryError),
      readString(record.endedReason),
      readString(record.pauseReason),
      readBooleanInteger(record.wakeOnDescendantSettle),
      typeof record.frozenResultText === "string" ? record.frozenResultText : null,
      readFiniteNumber(record.frozenResultCapturedAt),
      typeof record.fallbackFrozenResultText === "string" ? record.fallbackFrozenResultText : null,
      readFiniteNumber(record.fallbackFrozenResultCapturedAt),
      readFiniteNumber(record.endedHookEmittedAt),
      readBooleanInteger(record.pendingFinalDelivery),
      readFiniteNumber(record.pendingFinalDeliveryCreatedAt),
      readFiniteNumber(record.pendingFinalDeliveryLastAttemptAt),
      readFiniteNumber(record.pendingFinalDeliveryAttemptCount),
      typeof record.pendingFinalDeliveryLastError === "string"
        ? record.pendingFinalDeliveryLastError
        : null,
      readJsonText(record.pendingFinalDeliveryPayload),
      readFiniteNumber(record.completionAnnouncedAt),
      readString(record.attachmentsDir),
      readString(record.attachmentsRootDir),
      readBooleanInteger(record.retainAttachmentsOnKeep),
      row.value_json,
    );
  }

  db.prepare("DELETE FROM kv WHERE scope = 'subagent_runs'").run();
}

function migrateCurrentConversationBindingsFromKv(db: DatabaseSync): void {
  const legacyRows = db
    .prepare(
      "SELECT key, value_json, updated_at FROM kv WHERE scope = 'current-conversation-bindings'",
    )
    .all() as Array<{ key?: unknown; value_json?: unknown; updated_at?: unknown }>;
  if (legacyRows.length === 0) {
    return;
  }

  const insert = db.prepare(`
    INSERT OR REPLACE INTO current_conversation_bindings (
      binding_key,
      binding_id,
      channel,
      account_id,
      parent_conversation_id,
      conversation_id,
      target_session_key,
      target_kind,
      status,
      bound_at,
      expires_at,
      metadata_json,
      record_json,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of legacyRows) {
    if (typeof row.key !== "string" || typeof row.value_json !== "string") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value_json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const binding =
      (parsed as { version?: unknown; binding?: unknown }).version === 1
        ? (parsed as { binding?: unknown }).binding
        : parsed;
    if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
      continue;
    }
    const record = binding as Record<string, unknown>;
    const conversation = record.conversation;
    if (!conversation || typeof conversation !== "object" || Array.isArray(conversation)) {
      continue;
    }
    const conversationRecord = conversation as Record<string, unknown>;
    const channel = readString(conversationRecord.channel)?.toLowerCase();
    const accountId = readString(conversationRecord.accountId) ?? "default";
    const conversationId = readString(conversationRecord.conversationId);
    const parentConversationIdRaw = readString(conversationRecord.parentConversationId);
    const parentConversationId =
      parentConversationIdRaw && parentConversationIdRaw !== conversationId
        ? parentConversationIdRaw
        : null;
    const targetSessionKey = readString(record.targetSessionKey);
    if (!channel || !conversationId || !targetSessionKey) {
      continue;
    }
    const bindingKey = [channel, accountId, parentConversationId ?? "", conversationId].join(
      "\u241f",
    );
    const bindingId = `generic:${bindingKey}`;
    const targetKind = record.targetKind === "subagent" ? "subagent" : "session";
    const status =
      record.status === "ending" || record.status === "ended" ? record.status : "active";
    const updatedAt = readFiniteNumber(row.updated_at) ?? Date.now();
    const normalized = {
      ...record,
      bindingId,
      targetSessionKey,
      targetKind,
      status,
      conversation: {
        ...conversationRecord,
        channel,
        accountId,
        conversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
      },
    };
    insert.run(
      bindingKey,
      bindingId,
      channel,
      accountId,
      parentConversationId,
      conversationId,
      targetSessionKey,
      targetKind,
      status,
      readFiniteNumber(record.boundAt) ?? updatedAt,
      readFiniteNumber(record.expiresAt),
      readJsonText(record.metadata),
      JSON.stringify(normalized),
      updatedAt,
    );
  }

  db.prepare("DELETE FROM kv WHERE scope = 'current-conversation-bindings'").run();
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
  if (fromVersion < 19) {
    migrateCronJobRuntimeStateColumns(db);
  }
  if (fromVersion < 20) {
    migrateSubagentRunsFromKv(db);
  }
  if (fromVersion < 21) {
    migrateCurrentConversationBindingsFromKv(db);
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
