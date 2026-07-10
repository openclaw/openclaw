// SQLite-backed durable runtime store for the native control-plane prototype.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
import { ensureOpenClawStatePermissions } from "../state/openclaw-state-db.js";
import { resolveDurableRuntimeSqlitePath } from "./config.js";
import type {
  AppendDurableRuntimeEventInput,
  ClaimDurableRuntimeRunInput,
  ClaimDurableRuntimeStepInput,
  CompactDurableRuntimeRunInput,
  CompactDurableRuntimeRunResult,
  CreateDurableRuntimeLinkInput,
  CreateDurableRuntimeRefInput,
  CreateDurableRuntimeRunInput,
  CreateDurableRuntimeSignalInput,
  CreateDurableRuntimeStepInput,
  CreateDurableRuntimeTimerInput,
  DurableRuntimeLink,
  DurableRuntimeLinkStatus,
  DurableRuntimeLinkType,
  DurableRecoveryState,
  DurableRuntimeEvent,
  DurableRuntimeRef,
  DurableRuntimeRefKind,
  DurableRuntimeRun,
  DurableRuntimeRunStatus,
  DurableRuntimeSignal,
  DurableRuntimeStep,
  DurableRuntimeStepStatus,
  DurableRuntimeStepType,
  DurableRuntimeStore,
  DurableRuntimeStoreStats,
  DurableRuntimeTimelineOptions,
  DurableRuntimeTimer,
  DurableRuntimeTimerStatus,
  UpdateDurableRuntimeRunInput,
  UpdateDurableRuntimeLinkInput,
  UpdateDurableRuntimeStepInput,
  UpdateDurableRuntimeTimerInput,
} from "./types.js";

type DurableRuntimeRunRow = {
  runtime_run_id: string;
  operation_kind: string;
  operation_version: string;
  idempotency_key: string | null;
  request_hash: string | null;
  status: DurableRuntimeRunStatus;
  source_type: string | null;
  source_ref: string | null;
  input_ref: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  recovery_state: DurableRecoveryState;
  checkpoint_ref: string | null;
  parent_runtime_run_id: string | null;
  parent_step_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  work_unit_id: string | null;
  report_route_id: string | null;
  claimed_by: string | null;
  claim_expires_at: number | null;
  heartbeat_at: number | null;
  metadata_json: string | null;
};

type DurableRuntimeEventRow = {
  event_id: string;
  runtime_run_id: string;
  event_seq: number;
  event_type: string;
  event_time: number;
  step_id: string | null;
  agent_invocation_id: string | null;
  tool_invocation_id: string | null;
  idempotency_key: string | null;
  payload_json: string | null;
  payload_hash: string | null;
  checkpoint_ref: string | null;
  causation_event_id: string | null;
  correlation_id: string | null;
  recorded_at: number;
};

type DurableRuntimeStepRow = {
  runtime_run_id: string;
  step_id: string;
  parent_step_id: string | null;
  step_type: DurableRuntimeStepType;
  status: DurableRuntimeStepStatus;
  recovery_state: DurableRecoveryState;
  attempt: number;
  max_attempts: number | null;
  idempotency_key: string | null;
  input_ref: string | null;
  output_ref: string | null;
  error_ref: string | null;
  checkpoint_ref: string | null;
  claimed_by: string | null;
  claim_expires_at: number | null;
  heartbeat_at: number | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  metadata_json: string | null;
};

type DurableRuntimeRefRow = {
  ref_id: string;
  runtime_run_id: string;
  step_id: string | null;
  ref_kind: DurableRuntimeRefKind;
  media_type: string | null;
  hash: string | null;
  storage_kind: "inline" | "file" | "external";
  storage_uri: string | null;
  created_at: number;
  metadata_json: string | null;
};

type DurableRuntimeLinkRow = {
  parent_runtime_run_id: string;
  parent_step_id: string;
  child_runtime_run_id: string;
  link_type: DurableRuntimeLinkType;
  status: DurableRuntimeLinkStatus;
  created_at: number;
  updated_at: number;
  metadata_json: string | null;
};

type DurableRuntimeTimerRow = {
  timer_id: string;
  runtime_run_id: string;
  step_id: string | null;
  timer_type: DurableRuntimeTimer["timerType"];
  due_at: number;
  status: DurableRuntimeTimerStatus;
  created_at: number;
  fired_at: number | null;
  cancelled_at: number | null;
  metadata_json: string | null;
};

type DurableRuntimeSignalRow = {
  signal_id: string;
  runtime_run_id: string;
  step_id: string | null;
  signal_type: DurableRuntimeSignal["signalType"];
  idempotency_key: string | null;
  payload_ref: string | null;
  correlation_id: string | null;
  received_at: number;
  consumed_at: number | null;
  metadata_json: string | null;
};

type CountRow = { count: number | bigint };
type DurableSchemaMigrationRow = {
  schema_name: string;
  version: number | bigint;
  applied_at: number | bigint;
  metadata_json: string | null;
};

const DURABLE_RUNTIME_SQLITE_BUSY_TIMEOUT_MS = 30_000;
export const DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION = 1;
const DURABLE_RUNTIME_SQLITE_SCHEMA_NAME = "durable_runtime";

function optionalText(value: string | undefined): string | null {
  return value && value.trim() ? value : null;
}

function serializeJson(value: Record<string, unknown> | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function rowToRun(row: DurableRuntimeRunRow): DurableRuntimeRun {
  return {
    runtimeRunId: row.runtime_run_id,
    operationKind: row.operation_kind,
    operationVersion: row.operation_version,
    status: row.status,
    recoveryState: row.recovery_state,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.request_hash ? { requestHash: row.request_hash } : {}),
    ...(row.source_type ? { sourceType: row.source_type } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.input_ref ? { inputRef: row.input_ref } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.parent_runtime_run_id ? { parentRuntimeRunId: row.parent_runtime_run_id } : {}),
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.work_unit_id ? { workUnitId: row.work_unit_id } : {}),
    ...(row.report_route_id ? { reportRouteId: row.report_route_id } : {}),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at == null ? {} : { claimExpiresAt: Number(row.claim_expires_at) }),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: Number(row.heartbeat_at) }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.completed_at == null ? {} : { completedAt: Number(row.completed_at) }),
  };
}

function rowToEvent(row: DurableRuntimeEventRow): DurableRuntimeEvent {
  return {
    eventId: row.event_id,
    runtimeRunId: row.runtime_run_id,
    eventSeq: Number(row.event_seq),
    eventType: row.event_type,
    eventTime: Number(row.event_time),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.agent_invocation_id ? { agentInvocationId: row.agent_invocation_id } : {}),
    ...(row.tool_invocation_id ? { toolInvocationId: row.tool_invocation_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.payload_json ? { payload: parseJsonRecord(row.payload_json) } : {}),
    ...(row.payload_hash ? { payloadHash: row.payload_hash } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.causation_event_id ? { causationEventId: row.causation_event_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    recordedAt: Number(row.recorded_at),
  };
}

function rowToStep(row: DurableRuntimeStepRow): DurableRuntimeStep {
  return {
    runtimeRunId: row.runtime_run_id,
    stepId: row.step_id,
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    stepType: row.step_type,
    status: row.status,
    recoveryState: row.recovery_state,
    attempt: Number(row.attempt),
    ...(row.max_attempts == null ? {} : { maxAttempts: Number(row.max_attempts) }),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.input_ref ? { inputRef: row.input_ref } : {}),
    ...(row.output_ref ? { outputRef: row.output_ref } : {}),
    ...(row.error_ref ? { errorRef: row.error_ref } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at == null ? {} : { claimExpiresAt: Number(row.claim_expires_at) }),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: Number(row.heartbeat_at) }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    ...(row.started_at == null ? {} : { startedAt: Number(row.started_at) }),
    updatedAt: Number(row.updated_at),
    ...(row.completed_at == null ? {} : { completedAt: Number(row.completed_at) }),
  };
}

function rowToRef(row: DurableRuntimeRefRow): DurableRuntimeRef {
  return {
    refId: row.ref_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    refKind: row.ref_kind,
    ...(row.media_type ? { mediaType: row.media_type } : {}),
    ...(row.hash ? { hash: row.hash } : {}),
    storageKind: row.storage_kind,
    ...(row.storage_uri ? { storageUri: row.storage_uri } : {}),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
  };
}

function rowToLink(row: DurableRuntimeLinkRow): DurableRuntimeLink {
  return {
    parentRuntimeRunId: row.parent_runtime_run_id,
    parentStepId: row.parent_step_id,
    childRuntimeRunId: row.child_runtime_run_id,
    linkType: row.link_type,
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToTimer(row: DurableRuntimeTimerRow): DurableRuntimeTimer {
  return {
    timerId: row.timer_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    timerType: row.timer_type,
    dueAt: Number(row.due_at),
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    ...(row.fired_at == null ? {} : { firedAt: Number(row.fired_at) }),
    ...(row.cancelled_at == null ? {} : { cancelledAt: Number(row.cancelled_at) }),
  };
}

function rowToSignal(row: DurableRuntimeSignalRow): DurableRuntimeSignal {
  return {
    signalId: row.signal_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    signalType: row.signal_type,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.payload_ref ? { payloadRef: row.payload_ref } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    receivedAt: Number(row.received_at),
    ...(row.consumed_at == null ? {} : { consumedAt: Number(row.consumed_at) }),
  };
}

function ensureColumn(db: DatabaseSync, tableName: string, columnDefinition: string): void {
  try {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  } catch (err) {
    if (!String(err).includes("duplicate column name")) {
      throw err;
    }
  }
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { name?: string } | undefined;
  return row?.name === tableName;
}

function ensureDurableSchemaMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_schema_migrations (
      schema_name TEXT NOT NULL PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      metadata_json TEXT
    );
  `);
}

function ensureDurableRuntimeCompatibilityColumns(db: DatabaseSync): void {
  if (tableExists(db, "durable_runtime_runs")) {
    for (const column of [
      "parent_runtime_run_id TEXT",
      "parent_step_id TEXT",
      "message_id TEXT",
      "turn_id TEXT",
      "work_unit_id TEXT",
      "report_route_id TEXT",
      "claimed_by TEXT",
      "claim_expires_at INTEGER",
      "heartbeat_at INTEGER",
    ]) {
      ensureColumn(db, "durable_runtime_runs", column);
    }
  }
  if (tableExists(db, "durable_runtime_steps")) {
    for (const column of ["claimed_by TEXT", "claim_expires_at INTEGER", "heartbeat_at INTEGER"]) {
      ensureColumn(db, "durable_runtime_steps", column);
    }
  }
}

function ensureDurableRuntimeSchema(db: DatabaseSync): void {
  ensureDurableSchemaMigrationTable(db);
  assertDurableRuntimeSchemaVersionSupported(db);
  ensureDurableRuntimeCompatibilityColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_runtime_runs (
      runtime_run_id TEXT NOT NULL PRIMARY KEY,
      operation_kind TEXT NOT NULL,
      operation_version TEXT NOT NULL DEFAULT '1',
      idempotency_key TEXT,
      request_hash TEXT,
      status TEXT NOT NULL,
      source_type TEXT,
      source_ref TEXT,
      input_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      recovery_state TEXT NOT NULL DEFAULT 'runnable',
      checkpoint_ref TEXT,
      parent_runtime_run_id TEXT,
      parent_step_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      work_unit_id TEXT,
      report_route_id TEXT,
      claimed_by TEXT,
      claim_expires_at INTEGER,
      heartbeat_at INTEGER,
      metadata_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_runtime_runs_idempotency
      ON durable_runtime_runs(operation_kind, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_runs_status
      ON durable_runtime_runs(status, updated_at, runtime_run_id);

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_runs_work_unit
      ON durable_runtime_runs(work_unit_id, updated_at, runtime_run_id)
      WHERE work_unit_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_runs_report_route
      ON durable_runtime_runs(report_route_id, updated_at, runtime_run_id)
      WHERE report_route_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS durable_runtime_events (
      event_id TEXT NOT NULL UNIQUE,
      runtime_run_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_time INTEGER NOT NULL,
      step_id TEXT,
      agent_invocation_id TEXT,
      tool_invocation_id TEXT,
      idempotency_key TEXT,
      payload_json TEXT,
      payload_hash TEXT,
      checkpoint_ref TEXT,
      causation_event_id TEXT,
      correlation_id TEXT,
      recorded_at INTEGER NOT NULL,
      PRIMARY KEY (runtime_run_id, event_seq),
      FOREIGN KEY (runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_events_type
      ON durable_runtime_events(event_type, event_time, runtime_run_id);

    CREATE TABLE IF NOT EXISTS durable_runtime_steps (
      runtime_run_id TEXT NOT NULL,
      step_id TEXT NOT NULL,
      parent_step_id TEXT,
      step_type TEXT NOT NULL,
      status TEXT NOT NULL,
      recovery_state TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER,
      idempotency_key TEXT,
      input_ref TEXT,
      output_ref TEXT,
      error_ref TEXT,
      checkpoint_ref TEXT,
      claimed_by TEXT,
      claim_expires_at INTEGER,
      heartbeat_at INTEGER,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      metadata_json TEXT,
      PRIMARY KEY (runtime_run_id, step_id),
      FOREIGN KEY (runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_steps_status
      ON durable_runtime_steps(status, updated_at, runtime_run_id, step_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_runtime_steps_idempotency
      ON durable_runtime_steps(runtime_run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS durable_runtime_refs (
      ref_id TEXT NOT NULL PRIMARY KEY,
      runtime_run_id TEXT NOT NULL,
      step_id TEXT,
      ref_kind TEXT NOT NULL,
      media_type TEXT,
      hash TEXT,
      storage_kind TEXT NOT NULL,
      storage_uri TEXT,
      created_at INTEGER NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY (runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_refs_run
      ON durable_runtime_refs(runtime_run_id, ref_kind, created_at);

    CREATE TABLE IF NOT EXISTS durable_runtime_links (
      parent_runtime_run_id TEXT NOT NULL,
      parent_step_id TEXT NOT NULL,
      child_runtime_run_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (parent_runtime_run_id, parent_step_id, child_runtime_run_id),
      FOREIGN KEY (parent_runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE,
      FOREIGN KEY (child_runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_links_child
      ON durable_runtime_links(child_runtime_run_id, status);

    CREATE TABLE IF NOT EXISTS durable_runtime_timers (
      timer_id TEXT NOT NULL PRIMARY KEY,
      runtime_run_id TEXT NOT NULL,
      step_id TEXT,
      timer_type TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      cancelled_at INTEGER,
      metadata_json TEXT,
      FOREIGN KEY (runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_timers_due
      ON durable_runtime_timers(status, due_at, timer_id);

    CREATE TABLE IF NOT EXISTS durable_runtime_signals (
      signal_id TEXT NOT NULL PRIMARY KEY,
      runtime_run_id TEXT NOT NULL,
      step_id TEXT,
      signal_type TEXT NOT NULL,
      idempotency_key TEXT,
      payload_ref TEXT,
      correlation_id TEXT,
      received_at INTEGER NOT NULL,
      consumed_at INTEGER,
      metadata_json TEXT,
      FOREIGN KEY (runtime_run_id) REFERENCES durable_runtime_runs(runtime_run_id)
        ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_runtime_signals_idempotency
      ON durable_runtime_signals(runtime_run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_durable_runtime_signals_pending
      ON durable_runtime_signals(consumed_at, received_at, signal_id);
  `);
  for (const column of [
    "parent_runtime_run_id TEXT",
    "parent_step_id TEXT",
    "message_id TEXT",
    "turn_id TEXT",
    "work_unit_id TEXT",
    "report_route_id TEXT",
    "claimed_by TEXT",
    "claim_expires_at INTEGER",
    "heartbeat_at INTEGER",
  ]) {
    ensureColumn(db, "durable_runtime_runs", column);
  }
  for (const column of ["claimed_by TEXT", "claim_expires_at INTEGER", "heartbeat_at INTEGER"]) {
    ensureColumn(db, "durable_runtime_steps", column);
  }
  ensureDurableRuntimeSchemaVersion(db);
}

function readDurableRuntimeSchemaMigration(
  db: DatabaseSync,
): DurableSchemaMigrationRow | undefined {
  const row = db
    .prepare("SELECT * FROM durable_schema_migrations WHERE schema_name = ?")
    .get(DURABLE_RUNTIME_SQLITE_SCHEMA_NAME) as DurableSchemaMigrationRow | undefined;
  return row;
}

function assertDurableRuntimeSchemaVersionSupported(db: DatabaseSync): void {
  const row = readDurableRuntimeSchemaMigration(db);
  const currentVersion = Number(row?.version ?? 0);
  if (currentVersion > DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `Durable runtime schema version ${currentVersion} is newer than supported version ${DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION}`,
    );
  }
}

function ensureDurableRuntimeSchemaVersion(db: DatabaseSync): void {
  const now = Date.now();
  const row = readDurableRuntimeSchemaMigration(db);
  const currentVersion = Number(row?.version ?? 0);
  assertDurableRuntimeSchemaVersionSupported(db);
  if (currentVersion === DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION) {
    return;
  }

  const metadata = JSON.stringify({
    kind: currentVersion === 0 ? "fresh-install" : "schema-upgrade",
    previousVersion: currentVersion,
  });
  if (row) {
    db.prepare(
      `UPDATE durable_schema_migrations
          SET version = ?,
              applied_at = ?,
              metadata_json = ?
        WHERE schema_name = ?`,
    ).run(DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION, now, metadata, DURABLE_RUNTIME_SQLITE_SCHEMA_NAME);
    return;
  }

  db.prepare(
    `INSERT INTO durable_schema_migrations (schema_name, version, applied_at, metadata_json)
     VALUES (?, ?, ?, ?)`,
  ).run(DURABLE_RUNTIME_SQLITE_SCHEMA_NAME, DURABLE_RUNTIME_SQLITE_SCHEMA_VERSION, now, metadata);
}

function getDurableRuntimeSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT * FROM durable_schema_migrations WHERE schema_name = ?")
    .get(DURABLE_RUNTIME_SQLITE_SCHEMA_NAME) as DurableSchemaMigrationRow | undefined;
  return Number(row?.version ?? 0);
}

function count(db: DatabaseSync, sql: string, values: SQLInputValue[] = []): number {
  const row = db.prepare(sql).get(...values) as CountRow | undefined;
  return Number(row?.count ?? 0);
}

function normalizeQueryLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(5000, Math.trunc(limit ?? fallback)));
}

function isTerminalRunStatus(status: DurableRuntimeRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

function isTerminalStepStatus(status: DurableRuntimeStepStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "lost" ||
    status === "skipped"
  );
}

function isSameSqlValue(left: SQLInputValue | null, right: SQLInputValue | null): boolean {
  return left === right;
}

export function openDurableRuntimeSqliteStore(options?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): DurableRuntimeStore {
  const env = options?.env ?? process.env;
  const pathname = path.resolve(options?.path ?? resolveDurableRuntimeSqlitePath(env));
  ensureOpenClawStatePermissions(pathname, env);
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = configureSqliteConnectionPragmas(db, {
    busyTimeoutMs: DURABLE_RUNTIME_SQLITE_BUSY_TIMEOUT_MS,
    databaseLabel: "openclaw-durable-runtime",
    databasePath: pathname,
    foreignKeys: true,
    synchronous: "NORMAL",
  });
  try {
    ensureDurableRuntimeSchema(db);
    ensureOpenClawStatePermissions(pathname, env);
  } catch (err) {
    walMaintenance.close();
    if (db.isOpen) {
      db.close();
    }
    throw err;
  }

  return {
    createRun(input: CreateDurableRuntimeRunInput): DurableRuntimeRun {
      const now = input.now ?? Date.now();
      const runtimeRunId = input.runtimeRunId ?? `run_${randomUUID()}`;
      const operationVersion = input.operationVersion ?? "1";
      const status = input.status ?? "received";
      const recoveryState = input.recoveryState ?? "runnable";
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_runs
                WHERE operation_kind = ?
                  AND idempotency_key = ?`,
            )
            .get(input.operationKind, input.idempotencyKey) as DurableRuntimeRunRow | undefined);
        if (existing) {
          if (
            input.requestHash &&
            existing.request_hash &&
            existing.request_hash !== input.requestHash
          ) {
            throw new Error(
              `Durable runtime idempotency key conflict for ${input.operationKind}:${input.idempotencyKey}`,
            );
          }
          return rowToRun(existing);
        }
        db.prepare(
          `INSERT INTO durable_runtime_runs (
             runtime_run_id, operation_kind, operation_version, idempotency_key, request_hash,
             status, source_type, source_ref, input_ref, created_at, updated_at, completed_at,
             recovery_state, checkpoint_ref, parent_runtime_run_id, parent_step_id, message_id,
             turn_id, work_unit_id, report_route_id, claimed_by, claim_expires_at, heartbeat_at,
             metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runtimeRunId,
          input.operationKind,
          operationVersion,
          optionalText(input.idempotencyKey),
          optionalText(input.requestHash),
          status,
          optionalText(input.sourceType),
          optionalText(input.sourceRef),
          optionalText(input.inputRef),
          now,
          now,
          input.completedAt ?? null,
          recoveryState,
          optionalText(input.checkpointRef),
          optionalText(input.parentRuntimeRunId),
          optionalText(input.parentStepId),
          optionalText(input.messageId),
          optionalText(input.turnId),
          optionalText(input.workUnitId),
          optionalText(input.reportRouteId),
          null,
          null,
          null,
          serializeJson(input.metadata),
        );
        const row = db
          .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
          .get(runtimeRunId) as DurableRuntimeRunRow;
        return rowToRun(row);
      });
    },

    getRun(runtimeRunId: string): DurableRuntimeRun | undefined {
      const row = db
        .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
        .get(runtimeRunId) as DurableRuntimeRunRow | undefined;
      return row ? rowToRun(row) : undefined;
    },

    updateRun(input: UpdateDurableRuntimeRunInput): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
          .get(input.runtimeRunId) as DurableRuntimeRunRow | undefined;
        if (!current) {
          return undefined;
        }
        const completedAt =
          input.completedAt === undefined
            ? current.completed_at
            : input.completedAt === null
              ? null
              : input.completedAt;
        const nextStatus = input.status ?? current.status;
        const nextRecoveryState = input.recoveryState ?? current.recovery_state;
        const nextCheckpointRef =
          input.checkpointRef === undefined
            ? current.checkpoint_ref
            : optionalText(input.checkpointRef ?? undefined);
        const nextWorkUnitId =
          input.workUnitId === undefined
            ? current.work_unit_id
            : optionalText(input.workUnitId ?? undefined);
        const nextReportRouteId =
          input.reportRouteId === undefined
            ? current.report_route_id
            : optionalText(input.reportRouteId ?? undefined);
        const nextClaimedBy =
          input.claimedBy === undefined
            ? current.claimed_by
            : optionalText(input.claimedBy ?? undefined);
        const nextClaimExpiresAt =
          input.claimExpiresAt === undefined ? current.claim_expires_at : input.claimExpiresAt;
        const nextHeartbeatAt =
          input.heartbeatAt === undefined ? current.heartbeat_at : input.heartbeatAt;
        const nextMetadataJson =
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
        if (isTerminalRunStatus(current.status)) {
          const isNoOp =
            nextStatus === current.status &&
            nextRecoveryState === current.recovery_state &&
            isSameSqlValue(completedAt, current.completed_at) &&
            isSameSqlValue(nextCheckpointRef, current.checkpoint_ref) &&
            isSameSqlValue(nextWorkUnitId, current.work_unit_id) &&
            isSameSqlValue(nextReportRouteId, current.report_route_id) &&
            isSameSqlValue(nextClaimedBy, current.claimed_by) &&
            isSameSqlValue(nextClaimExpiresAt, current.claim_expires_at) &&
            isSameSqlValue(nextHeartbeatAt, current.heartbeat_at) &&
            isSameSqlValue(nextMetadataJson, current.metadata_json);
          return isNoOp ? rowToRun(current) : undefined;
        }
        db.prepare(
          `UPDATE durable_runtime_runs
              SET status = ?,
                  recovery_state = ?,
                  updated_at = ?,
                  completed_at = ?,
                  checkpoint_ref = ?,
                  work_unit_id = ?,
                  report_route_id = ?,
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  metadata_json = ?
            WHERE runtime_run_id = ?`,
        ).run(
          nextStatus,
          nextRecoveryState,
          now,
          completedAt,
          nextCheckpointRef,
          nextWorkUnitId,
          nextReportRouteId,
          nextClaimedBy,
          nextClaimExpiresAt,
          nextHeartbeatAt,
          nextMetadataJson,
          input.runtimeRunId,
        );
        const row = db
          .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
          .get(input.runtimeRunId) as DurableRuntimeRunRow;
        return rowToRun(row);
      });
    },

    appendEvent(input: AppendDurableRuntimeEventInput): DurableRuntimeEvent {
      const now = input.eventTime ?? Date.now();
      const recordedAt = Date.now();
      const eventId = input.eventId ?? `evt_${randomUUID()}`;
      return runSqliteImmediateTransactionSync(db, () => {
        const nextSeq = count(
          db,
          "SELECT COALESCE(MAX(event_seq), 0) + 1 AS count FROM durable_runtime_events WHERE runtime_run_id = ?",
          [input.runtimeRunId],
        );
        db.prepare(
          `INSERT INTO durable_runtime_events (
             event_id, runtime_run_id, event_seq, event_type, event_time, step_id,
             agent_invocation_id, tool_invocation_id, idempotency_key, payload_json,
             payload_hash, checkpoint_ref, causation_event_id, correlation_id, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId,
          input.runtimeRunId,
          nextSeq,
          input.eventType,
          now,
          optionalText(input.stepId),
          optionalText(input.agentInvocationId),
          optionalText(input.toolInvocationId),
          optionalText(input.idempotencyKey),
          serializeJson(input.payload),
          optionalText(input.payloadHash),
          optionalText(input.checkpointRef),
          optionalText(input.causationEventId),
          optionalText(input.correlationId),
          recordedAt,
        );
        db.prepare(
          `UPDATE durable_runtime_runs
              SET updated_at = ?
            WHERE runtime_run_id = ?`,
        ).run(recordedAt, input.runtimeRunId);
        const row = db
          .prepare(
            `SELECT *
               FROM durable_runtime_events
              WHERE runtime_run_id = ?
                AND event_seq = ?`,
          )
          .get(input.runtimeRunId, nextSeq) as DurableRuntimeEventRow;
        return rowToEvent(row);
      });
    },

    listRuns(options?: { limit?: number }): DurableRuntimeRun[] {
      const limit = Math.max(1, Math.min(500, Math.trunc(options?.limit ?? 50)));
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_runs
            ORDER BY updated_at DESC, runtime_run_id DESC
            LIMIT ?`,
        )
        .all(limit) as DurableRuntimeRunRow[];
      return rows.map(rowToRun);
    },

    listOpenRuns(options?: { operationKind?: string; limit?: number }): DurableRuntimeRun[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const operationKind = optionalText(options?.operationKind);
      const rows = operationKind
        ? (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_runs
                WHERE operation_kind = ?
                  AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
                ORDER BY updated_at ASC, runtime_run_id ASC
                LIMIT ?`,
            )
            .all(operationKind, limit) as DurableRuntimeRunRow[])
        : (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_runs
                WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
                ORDER BY updated_at ASC, runtime_run_id ASC
                LIMIT ?`,
            )
            .all(limit) as DurableRuntimeRunRow[]);
      return rows.map(rowToRun);
    },

    claimNextRunnableRun(input: ClaimDurableRuntimeRunInput): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const operationKind = optionalText(input.operationKind);
        const row = operationKind
          ? (db
              .prepare(
                `SELECT *
                  FROM durable_runtime_runs
                 WHERE operation_kind = ?
                   AND status IN ('received', 'queued')
                    AND recovery_state IN ('runnable', 'claimed')
                    AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
                  ORDER BY updated_at ASC, runtime_run_id ASC
                  LIMIT 1`,
              )
              .get(operationKind, now) as DurableRuntimeRunRow | undefined)
          : (db
              .prepare(
                `SELECT *
                  FROM durable_runtime_runs
                  WHERE status IN ('received', 'queued')
                    AND recovery_state IN ('runnable', 'claimed')
                    AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
                  ORDER BY updated_at ASC, runtime_run_id ASC
                  LIMIT 1`,
              )
              .get(now) as DurableRuntimeRunRow | undefined);
        if (!row) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_runtime_runs
              SET status = 'queued',
                  recovery_state = 'claimed',
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  updated_at = ?
            WHERE runtime_run_id = ?`,
        ).run(input.workerId, claimExpiresAt, now, now, row.runtime_run_id);
        const claimed = db
          .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
          .get(row.runtime_run_id) as DurableRuntimeRunRow;
        return rowToRun(claimed);
      });
    },

    releaseRunClaim(input: {
      runtimeRunId: string;
      workerId: string;
      now?: number;
    }): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const updateResult = db.prepare(
          `UPDATE durable_runtime_runs
              SET recovery_state = 'runnable',
                  claimed_by = NULL,
                  claim_expires_at = NULL,
                  heartbeat_at = NULL,
                  updated_at = ?
            WHERE runtime_run_id = ?
              AND claimed_by = ?`,
        );
        const update = updateResult.run(now, input.runtimeRunId, input.workerId);
        if (Number(update.changes ?? 0) === 0) {
          return undefined;
        }
        const row = db
          .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
          .get(input.runtimeRunId) as DurableRuntimeRunRow | undefined;
        return row ? rowToRun(row) : undefined;
      });
    },

    createStep(input: CreateDurableRuntimeStepInput): DurableRuntimeStep {
      const now = input.now ?? Date.now();
      const stepId = input.stepId ?? `step_${randomUUID()}`;
      const status = input.status ?? "pending";
      const recoveryState = input.recoveryState ?? "runnable";
      const attempt = input.attempt ?? 1;
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_steps
                WHERE runtime_run_id = ?
                  AND idempotency_key = ?`,
            )
            .get(input.runtimeRunId, input.idempotencyKey) as DurableRuntimeStepRow | undefined);
        if (existing) {
          return rowToStep(existing);
        }
        db.prepare(
          `INSERT INTO durable_runtime_steps (
             runtime_run_id, step_id, parent_step_id, step_type, status, recovery_state,
             attempt, max_attempts, idempotency_key, input_ref, output_ref, error_ref,
             checkpoint_ref, claimed_by, claim_expires_at, heartbeat_at, created_at,
             started_at, updated_at, completed_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.runtimeRunId,
          stepId,
          optionalText(input.parentStepId),
          input.stepType,
          status,
          recoveryState,
          attempt,
          input.maxAttempts ?? null,
          optionalText(input.idempotencyKey),
          optionalText(input.inputRef),
          optionalText(input.outputRef),
          optionalText(input.errorRef),
          optionalText(input.checkpointRef),
          null,
          null,
          null,
          now,
          status === "running" ? now : null,
          now,
          null,
          serializeJson(input.metadata),
        );
        const row = db
          .prepare("SELECT * FROM durable_runtime_steps WHERE runtime_run_id = ? AND step_id = ?")
          .get(input.runtimeRunId, stepId) as DurableRuntimeStepRow;
        return rowToStep(row);
      });
    },

    updateStep(input: UpdateDurableRuntimeStepInput): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare("SELECT * FROM durable_runtime_steps WHERE runtime_run_id = ? AND step_id = ?")
          .get(input.runtimeRunId, input.stepId) as DurableRuntimeStepRow | undefined;
        if (!current) {
          return undefined;
        }
        const expectedClaimedBy = optionalText(input.expectedClaimedBy);
        const nextStatus = input.status ?? current.status;
        const nextRecoveryState = input.recoveryState ?? current.recovery_state;
        const nextAttempt = input.attempt ?? current.attempt;
        const nextMaxAttempts =
          input.maxAttempts === undefined ? current.max_attempts : input.maxAttempts;
        const nextInputRef =
          input.inputRef === undefined
            ? current.input_ref
            : optionalText(input.inputRef ?? undefined);
        const nextOutputRef =
          input.outputRef === undefined
            ? current.output_ref
            : optionalText(input.outputRef ?? undefined);
        const nextErrorRef =
          input.errorRef === undefined
            ? current.error_ref
            : optionalText(input.errorRef ?? undefined);
        const nextCheckpointRef =
          input.checkpointRef === undefined
            ? current.checkpoint_ref
            : optionalText(input.checkpointRef ?? undefined);
        const nextClaimedBy =
          input.claimedBy === undefined
            ? current.claimed_by
            : optionalText(input.claimedBy ?? undefined);
        const nextClaimExpiresAt =
          input.claimExpiresAt === undefined ? current.claim_expires_at : input.claimExpiresAt;
        const nextHeartbeatAt =
          input.heartbeatAt === undefined ? current.heartbeat_at : input.heartbeatAt;
        const nextStartedAt =
          input.startedAt === undefined
            ? current.started_at
            : input.startedAt === null
              ? null
              : input.startedAt;
        const nextCompletedAt =
          input.completedAt === undefined
            ? current.completed_at
            : input.completedAt === null
              ? null
              : input.completedAt;
        const nextMetadataJson =
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
        if (isTerminalStepStatus(current.status)) {
          if (expectedClaimedBy && current.claimed_by !== expectedClaimedBy) {
            return undefined;
          }
          const isNoOp =
            nextStatus === current.status &&
            nextRecoveryState === current.recovery_state &&
            isSameSqlValue(nextAttempt, current.attempt) &&
            isSameSqlValue(nextMaxAttempts, current.max_attempts) &&
            isSameSqlValue(nextInputRef, current.input_ref) &&
            isSameSqlValue(nextOutputRef, current.output_ref) &&
            isSameSqlValue(nextErrorRef, current.error_ref) &&
            isSameSqlValue(nextCheckpointRef, current.checkpoint_ref) &&
            isSameSqlValue(nextClaimedBy, current.claimed_by) &&
            isSameSqlValue(nextClaimExpiresAt, current.claim_expires_at) &&
            isSameSqlValue(nextHeartbeatAt, current.heartbeat_at) &&
            isSameSqlValue(nextStartedAt, current.started_at) &&
            isSameSqlValue(nextCompletedAt, current.completed_at) &&
            isSameSqlValue(nextMetadataJson, current.metadata_json);
          return isNoOp ? rowToStep(current) : undefined;
        }
        const updateValues: SQLInputValue[] = [
          nextStatus,
          nextRecoveryState,
          nextAttempt,
          nextMaxAttempts,
          nextInputRef,
          nextOutputRef,
          nextErrorRef,
          nextCheckpointRef,
          nextClaimedBy,
          nextClaimExpiresAt,
          nextHeartbeatAt,
          nextStartedAt,
          nextCompletedAt,
          now,
          nextMetadataJson,
          input.runtimeRunId,
          input.stepId,
        ];
        if (expectedClaimedBy) {
          updateValues.push(expectedClaimedBy);
        }
        const updateResult = db.prepare(
          `UPDATE durable_runtime_steps
              SET status = ?,
                  recovery_state = ?,
                  attempt = ?,
                  max_attempts = ?,
                  input_ref = ?,
                  output_ref = ?,
                  error_ref = ?,
                  checkpoint_ref = ?,
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  started_at = ?,
                  completed_at = ?,
                  updated_at = ?,
                  metadata_json = ?
            WHERE runtime_run_id = ?
              AND step_id = ?
              ${expectedClaimedBy ? "AND claimed_by = ?" : ""}`,
        );
        const update = updateResult.run(...updateValues);
        if (expectedClaimedBy && Number(update.changes ?? 0) === 0) {
          return undefined;
        }
        const row = db
          .prepare("SELECT * FROM durable_runtime_steps WHERE runtime_run_id = ? AND step_id = ?")
          .get(input.runtimeRunId, input.stepId) as DurableRuntimeStepRow;
        return rowToStep(row);
      });
    },

    claimNextRunnableStep(input: ClaimDurableRuntimeStepInput): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const filters: string[] = [
          "s.status IN ('pending', 'queued')",
          "s.recovery_state IN ('runnable', 'claimed')",
          "(s.claimed_by IS NULL OR s.claim_expires_at IS NULL OR s.claim_expires_at <= ?)",
          "r.status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')",
        ];
        const values: SQLInputValue[] = [now];
        const operationKind = optionalText(input.operationKind);
        if (operationKind) {
          filters.push("r.operation_kind = ?");
          values.push(operationKind);
        }
        if (input.stepType) {
          filters.push("s.step_type = ?");
          values.push(input.stepType);
        }
        const row = db
          .prepare(
            `SELECT s.*
               FROM durable_runtime_steps s
               JOIN durable_runtime_runs r
                 ON r.runtime_run_id = s.runtime_run_id
              WHERE ${filters.join(" AND ")}
              ORDER BY s.updated_at ASC, s.runtime_run_id ASC, s.step_id ASC
              LIMIT 1`,
          )
          .get(...values) as DurableRuntimeStepRow | undefined;
        if (!row) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_runtime_steps
              SET status = 'queued',
                  recovery_state = 'claimed',
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  updated_at = ?
            WHERE runtime_run_id = ?
              AND step_id = ?`,
        ).run(input.workerId, claimExpiresAt, now, now, row.runtime_run_id, row.step_id);
        const claimed = db
          .prepare("SELECT * FROM durable_runtime_steps WHERE runtime_run_id = ? AND step_id = ?")
          .get(row.runtime_run_id, row.step_id) as DurableRuntimeStepRow;
        return rowToStep(claimed);
      });
    },

    releaseStepClaim(input: {
      runtimeRunId: string;
      stepId: string;
      workerId: string;
      now?: number;
    }): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const updateResult = db.prepare(
          `UPDATE durable_runtime_steps
              SET status = CASE WHEN status = 'running' THEN 'queued' ELSE status END,
                  recovery_state = 'runnable',
                  claimed_by = NULL,
                  claim_expires_at = NULL,
                  heartbeat_at = NULL,
                  updated_at = ?
            WHERE runtime_run_id = ?
              AND step_id = ?
              AND claimed_by = ?`,
        );
        const update = updateResult.run(now, input.runtimeRunId, input.stepId, input.workerId);
        if (Number(update.changes ?? 0) === 0) {
          return undefined;
        }
        const row = db
          .prepare("SELECT * FROM durable_runtime_steps WHERE runtime_run_id = ? AND step_id = ?")
          .get(input.runtimeRunId, input.stepId) as DurableRuntimeStepRow | undefined;
        return row ? rowToStep(row) : undefined;
      });
    },

    listSteps(runtimeRunId: string): DurableRuntimeStep[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_steps
            WHERE runtime_run_id = ?
            ORDER BY created_at ASC, step_id ASC`,
        )
        .all(runtimeRunId) as DurableRuntimeStepRow[];
      return rows.map(rowToStep);
    },

    createRef(input: CreateDurableRuntimeRefInput): DurableRuntimeRef {
      const now = input.now ?? Date.now();
      const refId = input.refId ?? `ref_${randomUUID()}`;
      db.prepare(
        `INSERT INTO durable_runtime_refs (
           ref_id, runtime_run_id, step_id, ref_kind, media_type, hash, storage_kind,
           storage_uri, created_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        refId,
        input.runtimeRunId,
        optionalText(input.stepId),
        input.refKind,
        optionalText(input.mediaType),
        optionalText(input.hash),
        input.storageKind ?? "external",
        optionalText(input.storageUri),
        now,
        serializeJson(input.metadata),
      );
      const row = db
        .prepare("SELECT * FROM durable_runtime_refs WHERE ref_id = ?")
        .get(refId) as DurableRuntimeRefRow;
      return rowToRef(row);
    },

    getRef(refId: string): DurableRuntimeRef | undefined {
      const row = db.prepare("SELECT * FROM durable_runtime_refs WHERE ref_id = ?").get(refId) as
        | DurableRuntimeRefRow
        | undefined;
      return row ? rowToRef(row) : undefined;
    },

    listRefs(runtimeRunId: string): DurableRuntimeRef[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_refs
            WHERE runtime_run_id = ?
            ORDER BY created_at ASC, ref_id ASC`,
        )
        .all(runtimeRunId) as DurableRuntimeRefRow[];
      return rows.map(rowToRef);
    },

    createLink(input: CreateDurableRuntimeLinkInput): DurableRuntimeLink {
      const now = input.now ?? Date.now();
      db.prepare(
        `INSERT INTO durable_runtime_links (
           parent_runtime_run_id, parent_step_id, child_runtime_run_id, link_type,
           status, created_at, updated_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.parentRuntimeRunId,
        input.parentStepId,
        input.childRuntimeRunId,
        input.linkType,
        input.status ?? "pending",
        now,
        now,
        serializeJson(input.metadata),
      );
      const row = db
        .prepare(
          `SELECT *
             FROM durable_runtime_links
            WHERE parent_runtime_run_id = ?
              AND parent_step_id = ?
              AND child_runtime_run_id = ?`,
        )
        .get(
          input.parentRuntimeRunId,
          input.parentStepId,
          input.childRuntimeRunId,
        ) as DurableRuntimeLinkRow;
      return rowToLink(row);
    },

    updateLink(input: UpdateDurableRuntimeLinkInput): DurableRuntimeLink | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare(
            `SELECT *
               FROM durable_runtime_links
              WHERE parent_runtime_run_id = ?
                AND parent_step_id = ?
                AND child_runtime_run_id = ?`,
          )
          .get(input.parentRuntimeRunId, input.parentStepId, input.childRuntimeRunId) as
          | DurableRuntimeLinkRow
          | undefined;
        if (!current) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_runtime_links
              SET status = ?,
                  updated_at = ?,
                  metadata_json = ?
            WHERE parent_runtime_run_id = ?
              AND parent_step_id = ?
              AND child_runtime_run_id = ?`,
        ).run(
          input.status ?? current.status,
          now,
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata),
          input.parentRuntimeRunId,
          input.parentStepId,
          input.childRuntimeRunId,
        );
        const row = db
          .prepare(
            `SELECT *
               FROM durable_runtime_links
              WHERE parent_runtime_run_id = ?
                AND parent_step_id = ?
                AND child_runtime_run_id = ?`,
          )
          .get(
            input.parentRuntimeRunId,
            input.parentStepId,
            input.childRuntimeRunId,
          ) as DurableRuntimeLinkRow;
        return rowToLink(row);
      });
    },

    listChildLinks(parentRuntimeRunId: string): DurableRuntimeLink[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_links
            WHERE parent_runtime_run_id = ?
            ORDER BY created_at ASC, child_runtime_run_id ASC`,
        )
        .all(parentRuntimeRunId) as DurableRuntimeLinkRow[];
      return rows.map(rowToLink);
    },

    listParentLinks(childRuntimeRunId: string): DurableRuntimeLink[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_links
            WHERE child_runtime_run_id = ?
            ORDER BY created_at ASC, parent_runtime_run_id ASC, parent_step_id ASC`,
        )
        .all(childRuntimeRunId) as DurableRuntimeLinkRow[];
      return rows.map(rowToLink);
    },

    createTimer(input: CreateDurableRuntimeTimerInput): DurableRuntimeTimer {
      const now = input.now ?? Date.now();
      const timerId = input.timerId ?? `timer_${randomUUID()}`;
      db.prepare(
        `INSERT INTO durable_runtime_timers (
           timer_id, runtime_run_id, step_id, timer_type, due_at, status, created_at,
           fired_at, cancelled_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        timerId,
        input.runtimeRunId,
        optionalText(input.stepId),
        input.timerType,
        input.dueAt,
        "pending",
        now,
        null,
        null,
        serializeJson(input.metadata),
      );
      const row = db
        .prepare("SELECT * FROM durable_runtime_timers WHERE timer_id = ?")
        .get(timerId) as DurableRuntimeTimerRow;
      return rowToTimer(row);
    },

    updateTimer(input: UpdateDurableRuntimeTimerInput): DurableRuntimeTimer | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare("SELECT * FROM durable_runtime_timers WHERE timer_id = ?")
          .get(input.timerId) as DurableRuntimeTimerRow | undefined;
        if (!current) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_runtime_timers
              SET status = ?,
                  fired_at = ?,
                  cancelled_at = ?
            WHERE timer_id = ?`,
        ).run(
          input.status,
          input.firedAt === undefined
            ? input.status === "fired"
              ? now
              : current.fired_at
            : input.firedAt,
          input.cancelledAt === undefined
            ? input.status === "cancelled"
              ? now
              : current.cancelled_at
            : input.cancelledAt,
          input.timerId,
        );
        const row = db
          .prepare("SELECT * FROM durable_runtime_timers WHERE timer_id = ?")
          .get(input.timerId) as DurableRuntimeTimerRow;
        return rowToTimer(row);
      });
    },

    listTimers(runtimeRunId?: string): DurableRuntimeTimer[] {
      const rows = runtimeRunId
        ? (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_timers
                WHERE runtime_run_id = ?
                ORDER BY due_at ASC, timer_id ASC`,
            )
            .all(runtimeRunId) as DurableRuntimeTimerRow[])
        : (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_timers
                ORDER BY due_at ASC, timer_id ASC`,
            )
            .all() as DurableRuntimeTimerRow[]);
      return rows.map(rowToTimer);
    },

    listDueTimers(now: number, options?: { limit?: number }): DurableRuntimeTimer[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_timers
            WHERE status = 'pending'
              AND due_at <= ?
            ORDER BY due_at ASC, timer_id ASC
            LIMIT ?`,
        )
        .all(now, limit) as DurableRuntimeTimerRow[];
      return rows.map(rowToTimer);
    },

    createSignal(input: CreateDurableRuntimeSignalInput): DurableRuntimeSignal {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          (db
            .prepare(
              `SELECT *
                 FROM durable_runtime_signals
                WHERE runtime_run_id = ?
                  AND idempotency_key = ?`,
            )
            .get(input.runtimeRunId, input.idempotencyKey) as DurableRuntimeSignalRow | undefined);
        if (existing) {
          return rowToSignal(existing);
        }
        const signalId = input.signalId ?? `sig_${randomUUID()}`;
        db.prepare(
          `INSERT INTO durable_runtime_signals (
             signal_id, runtime_run_id, step_id, signal_type, idempotency_key, payload_ref,
             correlation_id, received_at, consumed_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          signalId,
          input.runtimeRunId,
          optionalText(input.stepId),
          input.signalType,
          optionalText(input.idempotencyKey),
          optionalText(input.payloadRef),
          optionalText(input.correlationId),
          now,
          null,
          serializeJson(input.metadata),
        );
        const row = db
          .prepare("SELECT * FROM durable_runtime_signals WHERE signal_id = ?")
          .get(signalId) as DurableRuntimeSignalRow;
        return rowToSignal(row);
      });
    },

    consumeSignal(input: { signalId: string; now?: number }): DurableRuntimeSignal | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        db.prepare(
          `UPDATE durable_runtime_signals
              SET consumed_at = COALESCE(consumed_at, ?)
            WHERE signal_id = ?`,
        ).run(now, input.signalId);
        const row = db
          .prepare("SELECT * FROM durable_runtime_signals WHERE signal_id = ?")
          .get(input.signalId) as DurableRuntimeSignalRow | undefined;
        return row ? rowToSignal(row) : undefined;
      });
    },

    listPendingSignals(options?: { limit?: number }): DurableRuntimeSignal[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_signals
            WHERE consumed_at IS NULL
            ORDER BY received_at ASC, signal_id ASC
            LIMIT ?`,
        )
        .all(limit) as DurableRuntimeSignalRow[];
      return rows.map(rowToSignal);
    },

    listSignals(runtimeRunId: string): DurableRuntimeSignal[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_runtime_signals
            WHERE runtime_run_id = ?
            ORDER BY received_at ASC, signal_id ASC`,
        )
        .all(runtimeRunId) as DurableRuntimeSignalRow[];
      return rows.map(rowToSignal);
    },

    getTimeline(
      runtimeRunId: string,
      timelineOptions?: DurableRuntimeTimelineOptions,
    ): DurableRuntimeEvent[] {
      const afterEventSeq = Math.max(0, Math.trunc(timelineOptions?.afterEventSeq ?? 0));
      const rows =
        timelineOptions?.limit === undefined && afterEventSeq === 0
          ? (db
              .prepare(
                `SELECT *
                   FROM durable_runtime_events
                  WHERE runtime_run_id = ?
                  ORDER BY event_seq ASC`,
              )
              .all(runtimeRunId) as DurableRuntimeEventRow[])
          : (db
              .prepare(
                `SELECT *
                   FROM durable_runtime_events
                  WHERE runtime_run_id = ?
                    AND event_seq > ?
                  ORDER BY event_seq ASC
                  LIMIT ?`,
              )
              .all(
                runtimeRunId,
                afterEventSeq,
                normalizeQueryLimit(timelineOptions?.limit, 500),
              ) as DurableRuntimeEventRow[]);
      return rows.map(rowToEvent);
    },

    compactTerminalRun(input: CompactDurableRuntimeRunInput): CompactDurableRuntimeRunResult {
      const keepLastEvents = normalizeQueryLimit(input.keepLastEvents, 200);
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const run = db
          .prepare("SELECT * FROM durable_runtime_runs WHERE runtime_run_id = ?")
          .get(input.runtimeRunId) as DurableRuntimeRunRow | undefined;
        if (!run || !isTerminalRunStatus(run.status)) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const totalEvents = count(
          db,
          "SELECT COUNT(*) AS count FROM durable_runtime_events WHERE runtime_run_id = ?",
          [input.runtimeRunId],
        );
        if (totalEvents <= keepLastEvents) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const cutoff = db
          .prepare(
            `SELECT event_seq
               FROM durable_runtime_events
              WHERE runtime_run_id = ?
              ORDER BY event_seq DESC
              LIMIT 1 OFFSET ?`,
          )
          .get(input.runtimeRunId, keepLastEvents - 1) as
          | { event_seq: number | bigint }
          | undefined;
        const cutoffSeq = Number(cutoff?.event_seq ?? 0);
        if (cutoffSeq <= 1) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const deleteResult = db
          .prepare(
            `DELETE FROM durable_runtime_events
              WHERE runtime_run_id = ?
                AND event_seq < ?`,
          )
          .run(input.runtimeRunId, cutoffSeq);
        const removedEvents = Number(deleteResult.changes ?? 0);
        if (removedEvents <= 0) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const nextSeq =
          count(
            db,
            "SELECT COALESCE(MAX(event_seq), 0) AS count FROM durable_runtime_events WHERE runtime_run_id = ?",
            [input.runtimeRunId],
          ) + 1;
        db.prepare(
          `INSERT INTO durable_runtime_events (
             event_id, runtime_run_id, event_seq, event_type, event_time, step_id,
             agent_invocation_id, tool_invocation_id, idempotency_key, payload_json,
             payload_hash, checkpoint_ref, causation_event_id, correlation_id, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `evt_${randomUUID()}`,
          input.runtimeRunId,
          nextSeq,
          "runtime.history.compacted",
          now,
          null,
          null,
          null,
          null,
          serializeJson({
            removedEvents,
            keptLastEvents: keepLastEvents,
            compactedBeforeEventSeq: cutoffSeq,
          }),
          null,
          null,
          null,
          null,
          now,
        );
        return {
          runtimeRunId: input.runtimeRunId,
          compacted: true,
          removedEvents,
        };
      });
    },

    getStats(): DurableRuntimeStoreStats {
      return {
        path: pathname,
        schemaVersion: getDurableRuntimeSchemaVersion(db),
        runs: count(db, "SELECT COUNT(*) AS count FROM durable_runtime_runs"),
        events: count(db, "SELECT COUNT(*) AS count FROM durable_runtime_events"),
        steps: count(db, "SELECT COUNT(*) AS count FROM durable_runtime_steps"),
        openRuns: count(
          db,
          "SELECT COUNT(*) AS count FROM durable_runtime_runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')",
        ),
      };
    },

    close(): void {
      walMaintenance.close();
      if (db.isOpen) {
        db.close();
      }
    },
  };
}
