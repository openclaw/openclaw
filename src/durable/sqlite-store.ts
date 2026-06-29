// SQLite-backed durable workflow store for the native control-plane prototype.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
import { resolveDurableWorkflowSqlitePath } from "./config.js";
import type {
  AppendDurableWorkflowEventInput,
  ClaimDurableWorkflowRunInput,
  ClaimDurableWorkflowStepInput,
  CompactDurableWorkflowRunInput,
  CompactDurableWorkflowRunResult,
  CreateDurableWorkflowLinkInput,
  CreateDurableWorkflowRefInput,
  CreateDurableWorkflowRunInput,
  CreateDurableWorkflowSignalInput,
  CreateDurableWorkflowStepInput,
  CreateDurableWorkflowTimerInput,
  DurableWorkflowLink,
  DurableWorkflowLinkStatus,
  DurableWorkflowLinkType,
  DurableRecoveryState,
  DurableWorkflowEvent,
  DurableWorkflowRef,
  DurableWorkflowRefKind,
  DurableWorkflowRun,
  DurableWorkflowRunStatus,
  DurableWorkflowSignal,
  DurableWorkflowStep,
  DurableWorkflowStepStatus,
  DurableWorkflowStepType,
  DurableWorkflowStore,
  DurableWorkflowStoreStats,
  DurableWorkflowTimelineOptions,
  DurableWorkflowTimer,
  DurableWorkflowTimerStatus,
  UpdateDurableWorkflowRunInput,
  UpdateDurableWorkflowLinkInput,
  UpdateDurableWorkflowStepInput,
  UpdateDurableWorkflowTimerInput,
} from "./types.js";

type DurableWorkflowRunRow = {
  workflow_run_id: string;
  workflow_id: string;
  workflow_version: string;
  idempotency_key: string | null;
  request_hash: string | null;
  status: DurableWorkflowRunStatus;
  source_type: string | null;
  source_ref: string | null;
  input_ref: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  recovery_state: DurableRecoveryState;
  checkpoint_ref: string | null;
  parent_workflow_run_id: string | null;
  parent_step_id: string | null;
  message_id: string | null;
  turn_id: string | null;
  claimed_by: string | null;
  claim_expires_at: number | null;
  heartbeat_at: number | null;
  metadata_json: string | null;
};

type DurableWorkflowEventRow = {
  event_id: string;
  workflow_run_id: string;
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

type DurableWorkflowStepRow = {
  workflow_run_id: string;
  step_id: string;
  parent_step_id: string | null;
  step_type: DurableWorkflowStepType;
  status: DurableWorkflowStepStatus;
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

type DurableWorkflowRefRow = {
  ref_id: string;
  workflow_run_id: string;
  step_id: string | null;
  ref_kind: DurableWorkflowRefKind;
  media_type: string | null;
  hash: string | null;
  storage_kind: "inline" | "file" | "external";
  storage_uri: string | null;
  created_at: number;
  metadata_json: string | null;
};

type DurableWorkflowLinkRow = {
  parent_workflow_run_id: string;
  parent_step_id: string;
  child_workflow_run_id: string;
  link_type: DurableWorkflowLinkType;
  status: DurableWorkflowLinkStatus;
  created_at: number;
  updated_at: number;
  metadata_json: string | null;
};

type DurableWorkflowTimerRow = {
  timer_id: string;
  workflow_run_id: string;
  step_id: string | null;
  timer_type: DurableWorkflowTimer["timerType"];
  due_at: number;
  status: DurableWorkflowTimerStatus;
  created_at: number;
  fired_at: number | null;
  cancelled_at: number | null;
  metadata_json: string | null;
};

type DurableWorkflowSignalRow = {
  signal_id: string;
  workflow_run_id: string;
  step_id: string | null;
  signal_type: DurableWorkflowSignal["signalType"];
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

const DURABLE_WORKFLOW_SQLITE_BUSY_TIMEOUT_MS = 30_000;
export const DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION = 1;
const DURABLE_WORKFLOW_SQLITE_SCHEMA_NAME = "durable_workflows";

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

function rowToRun(row: DurableWorkflowRunRow): DurableWorkflowRun {
  return {
    workflowRunId: row.workflow_run_id,
    workflowId: row.workflow_id,
    workflowVersion: row.workflow_version,
    status: row.status,
    recoveryState: row.recovery_state,
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.request_hash ? { requestHash: row.request_hash } : {}),
    ...(row.source_type ? { sourceType: row.source_type } : {}),
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.input_ref ? { inputRef: row.input_ref } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.parent_workflow_run_id ? { parentWorkflowRunId: row.parent_workflow_run_id } : {}),
    ...(row.parent_step_id ? { parentStepId: row.parent_step_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at == null ? {} : { claimExpiresAt: Number(row.claim_expires_at) }),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: Number(row.heartbeat_at) }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.completed_at == null ? {} : { completedAt: Number(row.completed_at) }),
  };
}

function rowToEvent(row: DurableWorkflowEventRow): DurableWorkflowEvent {
  return {
    eventId: row.event_id,
    workflowRunId: row.workflow_run_id,
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

function rowToStep(row: DurableWorkflowStepRow): DurableWorkflowStep {
  return {
    workflowRunId: row.workflow_run_id,
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

function rowToRef(row: DurableWorkflowRefRow): DurableWorkflowRef {
  return {
    refId: row.ref_id,
    workflowRunId: row.workflow_run_id,
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

function rowToLink(row: DurableWorkflowLinkRow): DurableWorkflowLink {
  return {
    parentWorkflowRunId: row.parent_workflow_run_id,
    parentStepId: row.parent_step_id,
    childWorkflowRunId: row.child_workflow_run_id,
    linkType: row.link_type,
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToTimer(row: DurableWorkflowTimerRow): DurableWorkflowTimer {
  return {
    timerId: row.timer_id,
    workflowRunId: row.workflow_run_id,
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

function rowToSignal(row: DurableWorkflowSignalRow): DurableWorkflowSignal {
  return {
    signalId: row.signal_id,
    workflowRunId: row.workflow_run_id,
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

function ensureDurableWorkflowSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_schema_migrations (
      schema_name TEXT NOT NULL PRIMARY KEY,
      version INTEGER NOT NULL,
      applied_at INTEGER NOT NULL,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS durable_workflow_runs (
      workflow_run_id TEXT NOT NULL PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL DEFAULT '1',
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
      parent_workflow_run_id TEXT,
      parent_step_id TEXT,
      message_id TEXT,
      turn_id TEXT,
      claimed_by TEXT,
      claim_expires_at INTEGER,
      heartbeat_at INTEGER,
      metadata_json TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_workflow_runs_idempotency
      ON durable_workflow_runs(workflow_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_runs_status
      ON durable_workflow_runs(status, updated_at, workflow_run_id);

    CREATE TABLE IF NOT EXISTS durable_workflow_events (
      event_id TEXT NOT NULL UNIQUE,
      workflow_run_id TEXT NOT NULL,
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
      PRIMARY KEY (workflow_run_id, event_seq),
      FOREIGN KEY (workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_events_type
      ON durable_workflow_events(event_type, event_time, workflow_run_id);

    CREATE TABLE IF NOT EXISTS durable_workflow_steps (
      workflow_run_id TEXT NOT NULL,
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
      PRIMARY KEY (workflow_run_id, step_id),
      FOREIGN KEY (workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_steps_status
      ON durable_workflow_steps(status, updated_at, workflow_run_id, step_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_workflow_steps_idempotency
      ON durable_workflow_steps(workflow_run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS durable_workflow_refs (
      ref_id TEXT NOT NULL PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      step_id TEXT,
      ref_kind TEXT NOT NULL,
      media_type TEXT,
      hash TEXT,
      storage_kind TEXT NOT NULL,
      storage_uri TEXT,
      created_at INTEGER NOT NULL,
      metadata_json TEXT,
      FOREIGN KEY (workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_refs_run
      ON durable_workflow_refs(workflow_run_id, ref_kind, created_at);

    CREATE TABLE IF NOT EXISTS durable_workflow_links (
      parent_workflow_run_id TEXT NOT NULL,
      parent_step_id TEXT NOT NULL,
      child_workflow_run_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (parent_workflow_run_id, parent_step_id, child_workflow_run_id),
      FOREIGN KEY (parent_workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE,
      FOREIGN KEY (child_workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_links_child
      ON durable_workflow_links(child_workflow_run_id, status);

    CREATE TABLE IF NOT EXISTS durable_workflow_timers (
      timer_id TEXT NOT NULL PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      step_id TEXT,
      timer_type TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      fired_at INTEGER,
      cancelled_at INTEGER,
      metadata_json TEXT,
      FOREIGN KEY (workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_timers_due
      ON durable_workflow_timers(status, due_at, timer_id);

    CREATE TABLE IF NOT EXISTS durable_workflow_signals (
      signal_id TEXT NOT NULL PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      step_id TEXT,
      signal_type TEXT NOT NULL,
      idempotency_key TEXT,
      payload_ref TEXT,
      correlation_id TEXT,
      received_at INTEGER NOT NULL,
      consumed_at INTEGER,
      metadata_json TEXT,
      FOREIGN KEY (workflow_run_id) REFERENCES durable_workflow_runs(workflow_run_id)
        ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_durable_workflow_signals_idempotency
      ON durable_workflow_signals(workflow_run_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_durable_workflow_signals_pending
      ON durable_workflow_signals(consumed_at, received_at, signal_id);
  `);
  for (const column of [
    "parent_workflow_run_id TEXT",
    "parent_step_id TEXT",
    "message_id TEXT",
    "turn_id TEXT",
    "claimed_by TEXT",
    "claim_expires_at INTEGER",
    "heartbeat_at INTEGER",
  ]) {
    ensureColumn(db, "durable_workflow_runs", column);
  }
  for (const column of ["claimed_by TEXT", "claim_expires_at INTEGER", "heartbeat_at INTEGER"]) {
    ensureColumn(db, "durable_workflow_steps", column);
  }
  ensureDurableWorkflowSchemaVersion(db);
}

function ensureDurableWorkflowSchemaVersion(db: DatabaseSync): void {
  const now = Date.now();
  const row = db
    .prepare("SELECT * FROM durable_schema_migrations WHERE schema_name = ?")
    .get(DURABLE_WORKFLOW_SQLITE_SCHEMA_NAME) as DurableSchemaMigrationRow | undefined;
  const currentVersion = Number(row?.version ?? 0);
  if (currentVersion > DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION) {
    throw new Error(
      `Durable workflow schema version ${currentVersion} is newer than supported version ${DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION}`,
    );
  }
  if (currentVersion === DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION) {
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
    ).run(
      DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION,
      now,
      metadata,
      DURABLE_WORKFLOW_SQLITE_SCHEMA_NAME,
    );
    return;
  }

  db.prepare(
    `INSERT INTO durable_schema_migrations (schema_name, version, applied_at, metadata_json)
     VALUES (?, ?, ?, ?)`,
  ).run(DURABLE_WORKFLOW_SQLITE_SCHEMA_NAME, DURABLE_WORKFLOW_SQLITE_SCHEMA_VERSION, now, metadata);
}

function getDurableWorkflowSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT * FROM durable_schema_migrations WHERE schema_name = ?")
    .get(DURABLE_WORKFLOW_SQLITE_SCHEMA_NAME) as DurableSchemaMigrationRow | undefined;
  return Number(row?.version ?? 0);
}

function count(db: DatabaseSync, sql: string, values: SQLInputValue[] = []): number {
  const row = db.prepare(sql).get(...values) as CountRow | undefined;
  return Number(row?.count ?? 0);
}

function normalizeQueryLimit(limit: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(5000, Math.trunc(limit ?? fallback)));
}

function isTerminalRunStatus(status: DurableWorkflowRunStatus): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
  );
}

export function openDurableWorkflowSqliteStore(options?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): DurableWorkflowStore {
  const pathname = path.resolve(options?.path ?? resolveDurableWorkflowSqlitePath(options?.env));
  fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
  const sqlite = requireNodeSqlite();
  const db = new sqlite.DatabaseSync(pathname);
  const walMaintenance = configureSqliteConnectionPragmas(db, {
    busyTimeoutMs: DURABLE_WORKFLOW_SQLITE_BUSY_TIMEOUT_MS,
    databaseLabel: "openclaw-durable-workflows",
    databasePath: pathname,
    foreignKeys: true,
    synchronous: "NORMAL",
  });
  ensureDurableWorkflowSchema(db);

  return {
    createRun(input: CreateDurableWorkflowRunInput): DurableWorkflowRun {
      const now = input.now ?? Date.now();
      const workflowRunId = input.workflowRunId ?? `wfr_${randomUUID()}`;
      const workflowVersion = input.workflowVersion ?? "1";
      const status = input.status ?? "received";
      const recoveryState = input.recoveryState ?? "runnable";
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          (db
            .prepare(
              `SELECT *
                 FROM durable_workflow_runs
                WHERE workflow_id = ?
                  AND idempotency_key = ?`,
            )
            .get(input.workflowId, input.idempotencyKey) as DurableWorkflowRunRow | undefined);
        if (existing) {
          if (
            input.requestHash &&
            existing.request_hash &&
            existing.request_hash !== input.requestHash
          ) {
            throw new Error(
              `Durable workflow idempotency key conflict for ${input.workflowId}:${input.idempotencyKey}`,
            );
          }
          return rowToRun(existing);
        }
        db.prepare(
          `INSERT INTO durable_workflow_runs (
             workflow_run_id, workflow_id, workflow_version, idempotency_key, request_hash,
             status, source_type, source_ref, input_ref, created_at, updated_at, completed_at,
             recovery_state, checkpoint_ref, parent_workflow_run_id, parent_step_id, message_id,
             turn_id, claimed_by, claim_expires_at, heartbeat_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          workflowRunId,
          input.workflowId,
          workflowVersion,
          optionalText(input.idempotencyKey),
          optionalText(input.requestHash),
          status,
          optionalText(input.sourceType),
          optionalText(input.sourceRef),
          optionalText(input.inputRef),
          now,
          now,
          null,
          recoveryState,
          optionalText(input.checkpointRef),
          optionalText(input.parentWorkflowRunId),
          optionalText(input.parentStepId),
          optionalText(input.messageId),
          optionalText(input.turnId),
          null,
          null,
          null,
          serializeJson(input.metadata),
        );
        const row = db
          .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
          .get(workflowRunId) as DurableWorkflowRunRow;
        return rowToRun(row);
      });
    },

    getRun(workflowRunId: string): DurableWorkflowRun | undefined {
      const row = db
        .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
        .get(workflowRunId) as DurableWorkflowRunRow | undefined;
      return row ? rowToRun(row) : undefined;
    },

    updateRun(input: UpdateDurableWorkflowRunInput): DurableWorkflowRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
          .get(input.workflowRunId) as DurableWorkflowRunRow | undefined;
        if (!current) {
          return undefined;
        }
        const completedAt =
          input.completedAt === undefined
            ? current.completed_at
            : input.completedAt === null
              ? null
              : input.completedAt;
        db.prepare(
          `UPDATE durable_workflow_runs
              SET status = ?,
                  recovery_state = ?,
                  updated_at = ?,
                  completed_at = ?,
                  checkpoint_ref = ?,
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  metadata_json = ?
            WHERE workflow_run_id = ?`,
        ).run(
          input.status ?? current.status,
          input.recoveryState ?? current.recovery_state,
          now,
          completedAt,
          input.checkpointRef === undefined
            ? current.checkpoint_ref
            : optionalText(input.checkpointRef ?? undefined),
          input.claimedBy === undefined
            ? current.claimed_by
            : optionalText(input.claimedBy ?? undefined),
          input.claimExpiresAt === undefined ? current.claim_expires_at : input.claimExpiresAt,
          input.heartbeatAt === undefined ? current.heartbeat_at : input.heartbeatAt,
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata),
          input.workflowRunId,
        );
        const row = db
          .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
          .get(input.workflowRunId) as DurableWorkflowRunRow;
        return rowToRun(row);
      });
    },

    appendEvent(input: AppendDurableWorkflowEventInput): DurableWorkflowEvent {
      const now = input.eventTime ?? Date.now();
      const recordedAt = Date.now();
      const eventId = input.eventId ?? `wfe_${randomUUID()}`;
      return runSqliteImmediateTransactionSync(db, () => {
        const nextSeq = count(
          db,
          "SELECT COALESCE(MAX(event_seq), 0) + 1 AS count FROM durable_workflow_events WHERE workflow_run_id = ?",
          [input.workflowRunId],
        );
        db.prepare(
          `INSERT INTO durable_workflow_events (
             event_id, workflow_run_id, event_seq, event_type, event_time, step_id,
             agent_invocation_id, tool_invocation_id, idempotency_key, payload_json,
             payload_hash, checkpoint_ref, causation_event_id, correlation_id, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          eventId,
          input.workflowRunId,
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
          `UPDATE durable_workflow_runs
              SET updated_at = ?
            WHERE workflow_run_id = ?`,
        ).run(recordedAt, input.workflowRunId);
        const row = db
          .prepare(
            `SELECT *
               FROM durable_workflow_events
              WHERE workflow_run_id = ?
                AND event_seq = ?`,
          )
          .get(input.workflowRunId, nextSeq) as DurableWorkflowEventRow;
        return rowToEvent(row);
      });
    },

    listRuns(options?: { limit?: number }): DurableWorkflowRun[] {
      const limit = Math.max(1, Math.min(500, Math.trunc(options?.limit ?? 50)));
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_runs
            ORDER BY updated_at DESC, workflow_run_id DESC
            LIMIT ?`,
        )
        .all(limit) as DurableWorkflowRunRow[];
      return rows.map(rowToRun);
    },

    listOpenRuns(options?: { workflowId?: string; limit?: number }): DurableWorkflowRun[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const workflowId = optionalText(options?.workflowId);
      const rows = workflowId
        ? (db
            .prepare(
              `SELECT *
                 FROM durable_workflow_runs
                WHERE workflow_id = ?
                  AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
                ORDER BY updated_at ASC, workflow_run_id ASC
                LIMIT ?`,
            )
            .all(workflowId, limit) as DurableWorkflowRunRow[])
        : (db
            .prepare(
              `SELECT *
                 FROM durable_workflow_runs
                WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
                ORDER BY updated_at ASC, workflow_run_id ASC
                LIMIT ?`,
            )
            .all(limit) as DurableWorkflowRunRow[]);
      return rows.map(rowToRun);
    },

    claimNextRunnableRun(input: ClaimDurableWorkflowRunInput): DurableWorkflowRun | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const workflowId = optionalText(input.workflowId);
        const row = workflowId
          ? (db
              .prepare(
                `SELECT *
                  FROM durable_workflow_runs
                 WHERE workflow_id = ?
                   AND status IN ('received', 'queued')
                    AND recovery_state IN ('runnable', 'claimed')
                    AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
                  ORDER BY updated_at ASC, workflow_run_id ASC
                  LIMIT 1`,
              )
              .get(workflowId, now) as DurableWorkflowRunRow | undefined)
          : (db
              .prepare(
                `SELECT *
                  FROM durable_workflow_runs
                  WHERE status IN ('received', 'queued')
                    AND recovery_state IN ('runnable', 'claimed')
                    AND (claimed_by IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?)
                  ORDER BY updated_at ASC, workflow_run_id ASC
                  LIMIT 1`,
              )
              .get(now) as DurableWorkflowRunRow | undefined);
        if (!row) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_workflow_runs
              SET status = 'queued',
                  recovery_state = 'claimed',
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  updated_at = ?
            WHERE workflow_run_id = ?`,
        ).run(input.workerId, claimExpiresAt, now, now, row.workflow_run_id);
        const claimed = db
          .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
          .get(row.workflow_run_id) as DurableWorkflowRunRow;
        return rowToRun(claimed);
      });
    },

    releaseRunClaim(input: {
      workflowRunId: string;
      workerId: string;
      now?: number;
    }): DurableWorkflowRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const updateResult = db.prepare(
          `UPDATE durable_workflow_runs
              SET recovery_state = 'runnable',
                  claimed_by = NULL,
                  claim_expires_at = NULL,
                  heartbeat_at = NULL,
                  updated_at = ?
            WHERE workflow_run_id = ?
              AND claimed_by = ?`,
        );
        const update = updateResult.run(now, input.workflowRunId, input.workerId);
        if (Number(update.changes ?? 0) === 0) {
          return undefined;
        }
        const row = db
          .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
          .get(input.workflowRunId) as DurableWorkflowRunRow | undefined;
        return row ? rowToRun(row) : undefined;
      });
    },

    createStep(input: CreateDurableWorkflowStepInput): DurableWorkflowStep {
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
                 FROM durable_workflow_steps
                WHERE workflow_run_id = ?
                  AND idempotency_key = ?`,
            )
            .get(input.workflowRunId, input.idempotencyKey) as DurableWorkflowStepRow | undefined);
        if (existing) {
          return rowToStep(existing);
        }
        db.prepare(
          `INSERT INTO durable_workflow_steps (
             workflow_run_id, step_id, parent_step_id, step_type, status, recovery_state,
             attempt, max_attempts, idempotency_key, input_ref, output_ref, error_ref,
             checkpoint_ref, claimed_by, claim_expires_at, heartbeat_at, created_at,
             started_at, updated_at, completed_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.workflowRunId,
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
          .prepare("SELECT * FROM durable_workflow_steps WHERE workflow_run_id = ? AND step_id = ?")
          .get(input.workflowRunId, stepId) as DurableWorkflowStepRow;
        return rowToStep(row);
      });
    },

    updateStep(input: UpdateDurableWorkflowStepInput): DurableWorkflowStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare("SELECT * FROM durable_workflow_steps WHERE workflow_run_id = ? AND step_id = ?")
          .get(input.workflowRunId, input.stepId) as DurableWorkflowStepRow | undefined;
        if (!current) {
          return undefined;
        }
        const expectedClaimedBy = optionalText(input.expectedClaimedBy);
        const updateValues: SQLInputValue[] = [
          input.status ?? current.status,
          input.recoveryState ?? current.recovery_state,
          input.attempt ?? current.attempt,
          input.maxAttempts === undefined ? current.max_attempts : input.maxAttempts,
          input.inputRef === undefined
            ? current.input_ref
            : optionalText(input.inputRef ?? undefined),
          input.outputRef === undefined
            ? current.output_ref
            : optionalText(input.outputRef ?? undefined),
          input.errorRef === undefined
            ? current.error_ref
            : optionalText(input.errorRef ?? undefined),
          input.checkpointRef === undefined
            ? current.checkpoint_ref
            : optionalText(input.checkpointRef ?? undefined),
          input.claimedBy === undefined
            ? current.claimed_by
            : optionalText(input.claimedBy ?? undefined),
          input.claimExpiresAt === undefined ? current.claim_expires_at : input.claimExpiresAt,
          input.heartbeatAt === undefined ? current.heartbeat_at : input.heartbeatAt,
          input.startedAt === undefined
            ? current.started_at
            : input.startedAt === null
              ? null
              : input.startedAt,
          input.completedAt === undefined
            ? current.completed_at
            : input.completedAt === null
              ? null
              : input.completedAt,
          now,
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata),
          input.workflowRunId,
          input.stepId,
        ];
        if (expectedClaimedBy) {
          updateValues.push(expectedClaimedBy);
        }
        const updateResult = db.prepare(
          `UPDATE durable_workflow_steps
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
            WHERE workflow_run_id = ?
              AND step_id = ?
              ${expectedClaimedBy ? "AND claimed_by = ?" : ""}`,
        );
        const update = updateResult.run(...updateValues);
        if (expectedClaimedBy && Number(update.changes ?? 0) === 0) {
          return undefined;
        }
        const row = db
          .prepare("SELECT * FROM durable_workflow_steps WHERE workflow_run_id = ? AND step_id = ?")
          .get(input.workflowRunId, input.stepId) as DurableWorkflowStepRow;
        return rowToStep(row);
      });
    },

    claimNextRunnableStep(input: ClaimDurableWorkflowStepInput): DurableWorkflowStep | undefined {
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
        const workflowId = optionalText(input.workflowId);
        if (workflowId) {
          filters.push("r.workflow_id = ?");
          values.push(workflowId);
        }
        if (input.stepType) {
          filters.push("s.step_type = ?");
          values.push(input.stepType);
        }
        const row = db
          .prepare(
            `SELECT s.*
               FROM durable_workflow_steps s
               JOIN durable_workflow_runs r
                 ON r.workflow_run_id = s.workflow_run_id
              WHERE ${filters.join(" AND ")}
              ORDER BY s.updated_at ASC, s.workflow_run_id ASC, s.step_id ASC
              LIMIT 1`,
          )
          .get(...values) as DurableWorkflowStepRow | undefined;
        if (!row) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_workflow_steps
              SET status = 'queued',
                  recovery_state = 'claimed',
                  claimed_by = ?,
                  claim_expires_at = ?,
                  heartbeat_at = ?,
                  updated_at = ?
            WHERE workflow_run_id = ?
              AND step_id = ?`,
        ).run(input.workerId, claimExpiresAt, now, now, row.workflow_run_id, row.step_id);
        const claimed = db
          .prepare("SELECT * FROM durable_workflow_steps WHERE workflow_run_id = ? AND step_id = ?")
          .get(row.workflow_run_id, row.step_id) as DurableWorkflowStepRow;
        return rowToStep(claimed);
      });
    },

    releaseStepClaim(input: {
      workflowRunId: string;
      stepId: string;
      workerId: string;
      now?: number;
    }): DurableWorkflowStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const updateResult = db.prepare(
          `UPDATE durable_workflow_steps
              SET status = CASE WHEN status = 'running' THEN 'queued' ELSE status END,
                  recovery_state = 'runnable',
                  claimed_by = NULL,
                  claim_expires_at = NULL,
                  heartbeat_at = NULL,
                  updated_at = ?
            WHERE workflow_run_id = ?
              AND step_id = ?
              AND claimed_by = ?`,
        );
        const update = updateResult.run(now, input.workflowRunId, input.stepId, input.workerId);
        if (Number(update.changes ?? 0) === 0) {
          return undefined;
        }
        const row = db
          .prepare("SELECT * FROM durable_workflow_steps WHERE workflow_run_id = ? AND step_id = ?")
          .get(input.workflowRunId, input.stepId) as DurableWorkflowStepRow | undefined;
        return row ? rowToStep(row) : undefined;
      });
    },

    listSteps(workflowRunId: string): DurableWorkflowStep[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_steps
            WHERE workflow_run_id = ?
            ORDER BY created_at ASC, step_id ASC`,
        )
        .all(workflowRunId) as DurableWorkflowStepRow[];
      return rows.map(rowToStep);
    },

    createRef(input: CreateDurableWorkflowRefInput): DurableWorkflowRef {
      const now = input.now ?? Date.now();
      const refId = input.refId ?? `ref_${randomUUID()}`;
      db.prepare(
        `INSERT INTO durable_workflow_refs (
           ref_id, workflow_run_id, step_id, ref_kind, media_type, hash, storage_kind,
           storage_uri, created_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        refId,
        input.workflowRunId,
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
        .prepare("SELECT * FROM durable_workflow_refs WHERE ref_id = ?")
        .get(refId) as DurableWorkflowRefRow;
      return rowToRef(row);
    },

    getRef(refId: string): DurableWorkflowRef | undefined {
      const row = db.prepare("SELECT * FROM durable_workflow_refs WHERE ref_id = ?").get(refId) as
        | DurableWorkflowRefRow
        | undefined;
      return row ? rowToRef(row) : undefined;
    },

    listRefs(workflowRunId: string): DurableWorkflowRef[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_refs
            WHERE workflow_run_id = ?
            ORDER BY created_at ASC, ref_id ASC`,
        )
        .all(workflowRunId) as DurableWorkflowRefRow[];
      return rows.map(rowToRef);
    },

    createLink(input: CreateDurableWorkflowLinkInput): DurableWorkflowLink {
      const now = input.now ?? Date.now();
      db.prepare(
        `INSERT INTO durable_workflow_links (
           parent_workflow_run_id, parent_step_id, child_workflow_run_id, link_type,
           status, created_at, updated_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.parentWorkflowRunId,
        input.parentStepId,
        input.childWorkflowRunId,
        input.linkType,
        input.status ?? "pending",
        now,
        now,
        serializeJson(input.metadata),
      );
      const row = db
        .prepare(
          `SELECT *
             FROM durable_workflow_links
            WHERE parent_workflow_run_id = ?
              AND parent_step_id = ?
              AND child_workflow_run_id = ?`,
        )
        .get(
          input.parentWorkflowRunId,
          input.parentStepId,
          input.childWorkflowRunId,
        ) as DurableWorkflowLinkRow;
      return rowToLink(row);
    },

    updateLink(input: UpdateDurableWorkflowLinkInput): DurableWorkflowLink | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare(
            `SELECT *
               FROM durable_workflow_links
              WHERE parent_workflow_run_id = ?
                AND parent_step_id = ?
                AND child_workflow_run_id = ?`,
          )
          .get(input.parentWorkflowRunId, input.parentStepId, input.childWorkflowRunId) as
          | DurableWorkflowLinkRow
          | undefined;
        if (!current) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_workflow_links
              SET status = ?,
                  updated_at = ?,
                  metadata_json = ?
            WHERE parent_workflow_run_id = ?
              AND parent_step_id = ?
              AND child_workflow_run_id = ?`,
        ).run(
          input.status ?? current.status,
          now,
          input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata),
          input.parentWorkflowRunId,
          input.parentStepId,
          input.childWorkflowRunId,
        );
        const row = db
          .prepare(
            `SELECT *
               FROM durable_workflow_links
              WHERE parent_workflow_run_id = ?
                AND parent_step_id = ?
                AND child_workflow_run_id = ?`,
          )
          .get(
            input.parentWorkflowRunId,
            input.parentStepId,
            input.childWorkflowRunId,
          ) as DurableWorkflowLinkRow;
        return rowToLink(row);
      });
    },

    listChildLinks(parentWorkflowRunId: string): DurableWorkflowLink[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_links
            WHERE parent_workflow_run_id = ?
            ORDER BY created_at ASC, child_workflow_run_id ASC`,
        )
        .all(parentWorkflowRunId) as DurableWorkflowLinkRow[];
      return rows.map(rowToLink);
    },

    listParentLinks(childWorkflowRunId: string): DurableWorkflowLink[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_links
            WHERE child_workflow_run_id = ?
            ORDER BY created_at ASC, parent_workflow_run_id ASC, parent_step_id ASC`,
        )
        .all(childWorkflowRunId) as DurableWorkflowLinkRow[];
      return rows.map(rowToLink);
    },

    createTimer(input: CreateDurableWorkflowTimerInput): DurableWorkflowTimer {
      const now = input.now ?? Date.now();
      const timerId = input.timerId ?? `timer_${randomUUID()}`;
      db.prepare(
        `INSERT INTO durable_workflow_timers (
           timer_id, workflow_run_id, step_id, timer_type, due_at, status, created_at,
           fired_at, cancelled_at, metadata_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        timerId,
        input.workflowRunId,
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
        .prepare("SELECT * FROM durable_workflow_timers WHERE timer_id = ?")
        .get(timerId) as DurableWorkflowTimerRow;
      return rowToTimer(row);
    },

    updateTimer(input: UpdateDurableWorkflowTimerInput): DurableWorkflowTimer | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = db
          .prepare("SELECT * FROM durable_workflow_timers WHERE timer_id = ?")
          .get(input.timerId) as DurableWorkflowTimerRow | undefined;
        if (!current) {
          return undefined;
        }
        db.prepare(
          `UPDATE durable_workflow_timers
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
          .prepare("SELECT * FROM durable_workflow_timers WHERE timer_id = ?")
          .get(input.timerId) as DurableWorkflowTimerRow;
        return rowToTimer(row);
      });
    },

    listTimers(workflowRunId?: string): DurableWorkflowTimer[] {
      const rows = workflowRunId
        ? (db
            .prepare(
              `SELECT *
                 FROM durable_workflow_timers
                WHERE workflow_run_id = ?
                ORDER BY due_at ASC, timer_id ASC`,
            )
            .all(workflowRunId) as DurableWorkflowTimerRow[])
        : (db
            .prepare(
              `SELECT *
                 FROM durable_workflow_timers
                ORDER BY due_at ASC, timer_id ASC`,
            )
            .all() as DurableWorkflowTimerRow[]);
      return rows.map(rowToTimer);
    },

    listDueTimers(now: number, options?: { limit?: number }): DurableWorkflowTimer[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_timers
            WHERE status = 'pending'
              AND due_at <= ?
            ORDER BY due_at ASC, timer_id ASC
            LIMIT ?`,
        )
        .all(now, limit) as DurableWorkflowTimerRow[];
      return rows.map(rowToTimer);
    },

    createSignal(input: CreateDurableWorkflowSignalInput): DurableWorkflowSignal {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          (db
            .prepare(
              `SELECT *
                 FROM durable_workflow_signals
                WHERE workflow_run_id = ?
                  AND idempotency_key = ?`,
            )
            .get(input.workflowRunId, input.idempotencyKey) as
            | DurableWorkflowSignalRow
            | undefined);
        if (existing) {
          return rowToSignal(existing);
        }
        const signalId = input.signalId ?? `sig_${randomUUID()}`;
        db.prepare(
          `INSERT INTO durable_workflow_signals (
             signal_id, workflow_run_id, step_id, signal_type, idempotency_key, payload_ref,
             correlation_id, received_at, consumed_at, metadata_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          signalId,
          input.workflowRunId,
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
          .prepare("SELECT * FROM durable_workflow_signals WHERE signal_id = ?")
          .get(signalId) as DurableWorkflowSignalRow;
        return rowToSignal(row);
      });
    },

    consumeSignal(input: { signalId: string; now?: number }): DurableWorkflowSignal | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        db.prepare(
          `UPDATE durable_workflow_signals
              SET consumed_at = COALESCE(consumed_at, ?)
            WHERE signal_id = ?`,
        ).run(now, input.signalId);
        const row = db
          .prepare("SELECT * FROM durable_workflow_signals WHERE signal_id = ?")
          .get(input.signalId) as DurableWorkflowSignalRow | undefined;
        return row ? rowToSignal(row) : undefined;
      });
    },

    listPendingSignals(options?: { limit?: number }): DurableWorkflowSignal[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_signals
            WHERE consumed_at IS NULL
            ORDER BY received_at ASC, signal_id ASC
            LIMIT ?`,
        )
        .all(limit) as DurableWorkflowSignalRow[];
      return rows.map(rowToSignal);
    },

    listSignals(workflowRunId: string): DurableWorkflowSignal[] {
      const rows = db
        .prepare(
          `SELECT *
             FROM durable_workflow_signals
            WHERE workflow_run_id = ?
            ORDER BY received_at ASC, signal_id ASC`,
        )
        .all(workflowRunId) as DurableWorkflowSignalRow[];
      return rows.map(rowToSignal);
    },

    getTimeline(
      workflowRunId: string,
      timelineOptions?: DurableWorkflowTimelineOptions,
    ): DurableWorkflowEvent[] {
      const afterEventSeq = Math.max(0, Math.trunc(timelineOptions?.afterEventSeq ?? 0));
      const rows =
        timelineOptions?.limit === undefined && afterEventSeq === 0
          ? (db
              .prepare(
                `SELECT *
                   FROM durable_workflow_events
                  WHERE workflow_run_id = ?
                  ORDER BY event_seq ASC`,
              )
              .all(workflowRunId) as DurableWorkflowEventRow[])
          : (db
              .prepare(
                `SELECT *
                   FROM durable_workflow_events
                  WHERE workflow_run_id = ?
                    AND event_seq > ?
                  ORDER BY event_seq ASC
                  LIMIT ?`,
              )
              .all(
                workflowRunId,
                afterEventSeq,
                normalizeQueryLimit(timelineOptions?.limit, 500),
              ) as DurableWorkflowEventRow[]);
      return rows.map(rowToEvent);
    },

    compactTerminalRun(input: CompactDurableWorkflowRunInput): CompactDurableWorkflowRunResult {
      const keepLastEvents = normalizeQueryLimit(input.keepLastEvents, 200);
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const run = db
          .prepare("SELECT * FROM durable_workflow_runs WHERE workflow_run_id = ?")
          .get(input.workflowRunId) as DurableWorkflowRunRow | undefined;
        if (!run || !isTerminalRunStatus(run.status)) {
          return {
            workflowRunId: input.workflowRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const totalEvents = count(
          db,
          "SELECT COUNT(*) AS count FROM durable_workflow_events WHERE workflow_run_id = ?",
          [input.workflowRunId],
        );
        if (totalEvents <= keepLastEvents) {
          return {
            workflowRunId: input.workflowRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const cutoff = db
          .prepare(
            `SELECT event_seq
               FROM durable_workflow_events
              WHERE workflow_run_id = ?
              ORDER BY event_seq DESC
              LIMIT 1 OFFSET ?`,
          )
          .get(input.workflowRunId, keepLastEvents - 1) as
          | { event_seq: number | bigint }
          | undefined;
        const cutoffSeq = Number(cutoff?.event_seq ?? 0);
        if (cutoffSeq <= 1) {
          return {
            workflowRunId: input.workflowRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const deleteResult = db
          .prepare(
            `DELETE FROM durable_workflow_events
              WHERE workflow_run_id = ?
                AND event_seq < ?`,
          )
          .run(input.workflowRunId, cutoffSeq);
        const removedEvents = Number(deleteResult.changes ?? 0);
        if (removedEvents <= 0) {
          return {
            workflowRunId: input.workflowRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const nextSeq =
          count(
            db,
            "SELECT COALESCE(MAX(event_seq), 0) AS count FROM durable_workflow_events WHERE workflow_run_id = ?",
            [input.workflowRunId],
          ) + 1;
        db.prepare(
          `INSERT INTO durable_workflow_events (
             event_id, workflow_run_id, event_seq, event_type, event_time, step_id,
             agent_invocation_id, tool_invocation_id, idempotency_key, payload_json,
             payload_hash, checkpoint_ref, causation_event_id, correlation_id, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          `evt_${randomUUID()}`,
          input.workflowRunId,
          nextSeq,
          "workflow.history.compacted",
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
          workflowRunId: input.workflowRunId,
          compacted: true,
          removedEvents,
        };
      });
    },

    getStats(): DurableWorkflowStoreStats {
      return {
        path: pathname,
        schemaVersion: getDurableWorkflowSchemaVersion(db),
        runs: count(db, "SELECT COUNT(*) AS count FROM durable_workflow_runs"),
        events: count(db, "SELECT COUNT(*) AS count FROM durable_workflow_events"),
        steps: count(db, "SELECT COUNT(*) AS count FROM durable_workflow_steps"),
        openRuns: count(
          db,
          "SELECT COUNT(*) AS count FROM durable_workflow_runs WHERE status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')",
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
