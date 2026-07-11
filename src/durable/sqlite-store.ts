// SQLite-backed durable runtime store for the native control-plane prototype.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  closeOpenClawStateDatabaseForPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
    ...(row.claim_expires_at == null ? {} : { claimExpiresAt: row.claim_expires_at }),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: row.heartbeat_at }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
  };
}

function rowToEvent(row: DurableRuntimeEventRow): DurableRuntimeEvent {
  return {
    eventId: row.event_id,
    runtimeRunId: row.runtime_run_id,
    eventSeq: row.event_seq,
    eventType: row.event_type,
    eventTime: row.event_time,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.agent_invocation_id ? { agentInvocationId: row.agent_invocation_id } : {}),
    ...(row.tool_invocation_id ? { toolInvocationId: row.tool_invocation_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.payload_json ? { payload: parseJsonRecord(row.payload_json) } : {}),
    ...(row.payload_hash ? { payloadHash: row.payload_hash } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.causation_event_id ? { causationEventId: row.causation_event_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    recordedAt: row.recorded_at,
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
    attempt: row.attempt,
    ...(row.max_attempts == null ? {} : { maxAttempts: row.max_attempts }),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    ...(row.input_ref ? { inputRef: row.input_ref } : {}),
    ...(row.output_ref ? { outputRef: row.output_ref } : {}),
    ...(row.error_ref ? { errorRef: row.error_ref } : {}),
    ...(row.checkpoint_ref ? { checkpointRef: row.checkpoint_ref } : {}),
    ...(row.claimed_by ? { claimedBy: row.claimed_by } : {}),
    ...(row.claim_expires_at == null ? {} : { claimExpiresAt: row.claim_expires_at }),
    ...(row.heartbeat_at == null ? {} : { heartbeatAt: row.heartbeat_at }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
    ...(row.started_at == null ? {} : { startedAt: row.started_at }),
    updatedAt: row.updated_at,
    ...(row.completed_at == null ? {} : { completedAt: row.completed_at }),
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
    createdAt: row.created_at,
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTimer(row: DurableRuntimeTimerRow): DurableRuntimeTimer {
  return {
    timerId: row.timer_id,
    runtimeRunId: row.runtime_run_id,
    ...(row.step_id ? { stepId: row.step_id } : {}),
    timerType: row.timer_type,
    dueAt: row.due_at,
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: row.created_at,
    ...(row.fired_at == null ? {} : { firedAt: row.fired_at }),
    ...(row.cancelled_at == null ? {} : { cancelledAt: row.cancelled_at }),
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
    receivedAt: row.received_at,
    ...(row.consumed_at == null ? {} : { consumedAt: row.consumed_at }),
  };
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

function isTerminalRunRow(row: DurableRuntimeRunRow): boolean {
  return (
    isTerminalRunStatus(row.status) ||
    row.recovery_state === "terminal" ||
    row.completed_at !== null
  );
}

function isTerminalStepRow(row: DurableRuntimeStepRow): boolean {
  return (
    isTerminalStepStatus(row.status) ||
    row.recovery_state === "terminal" ||
    row.completed_at !== null
  );
}

function isSameSqlValue(left: SQLInputValue | null, right: SQLInputValue | null): boolean {
  return left === right;
}

export function openDurableRuntimeSqliteStore(storeOptions?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): DurableRuntimeStore {
  const env = storeOptions?.env ?? process.env;
  const pathname = path.resolve(storeOptions?.path ?? resolveDurableRuntimeSqlitePath(env));
  const stateDatabase = openOpenClawStateDatabase({ env, path: pathname });
  const db = stateDatabase.db;
  let closed = false;

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
        if (isTerminalRunRow(current)) {
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
              AND claimed_by = ?
              AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost')
              AND recovery_state != 'terminal'
              AND completed_at IS NULL`,
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
        if (isTerminalStepRow(current)) {
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
              AND claimed_by = ?
              AND status NOT IN ('succeeded', 'failed', 'cancelled', 'lost', 'skipped')
              AND recovery_state != 'terminal'
              AND completed_at IS NULL`,
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
        schemaVersion: OPENCLAW_STATE_SCHEMA_VERSION,
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
      if (closed) {
        return;
      }
      closed = true;
      closeOpenClawStateDatabaseForPath({ env, path: pathname });
    },
  };
}
