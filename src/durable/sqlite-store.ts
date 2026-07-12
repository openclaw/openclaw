// SQLite-backed durable runtime store for the native control-plane prototype.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  OPENCLAW_STATE_SCHEMA_VERSION,
  acquireOpenClawStateDatabaseLease,
  closeOpenClawStateDatabaseForPath,
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
type DurableRuntimeDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "durable_runtime_events"
  | "durable_runtime_links"
  | "durable_runtime_refs"
  | "durable_runtime_runs"
  | "durable_runtime_signals"
  | "durable_runtime_steps"
  | "durable_runtime_timers"
>;
type SyncQuery<Row> = Parameters<typeof executeSqliteQuerySync<Row>>[1];

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

function queryRows<Row>(db: DatabaseSync, query: SyncQuery<Row>): Row[] {
  return executeSqliteQuerySync(db, query).rows as Row[];
}

function queryFirst<Row>(db: DatabaseSync, query: SyncQuery<Row>): Row | undefined {
  return executeSqliteQueryTakeFirstSync(db, query) as Row | undefined;
}

function executeQuery(db: DatabaseSync, query: SyncQuery<unknown>): number {
  const result = executeSqliteQuerySync(db, query);
  return Number(result.numAffectedRows ?? 0);
}

function count(db: DatabaseSync, query: SyncQuery<CountRow>): number {
  const row = queryFirst<CountRow>(db, query);
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

function isSameSqlValue(left: string | number | null, right: string | number | null): boolean {
  return left === right;
}

export function openDurableRuntimeSqliteStore(storeOptions?: {
  path?: string;
  env?: NodeJS.ProcessEnv;
}): DurableRuntimeStore {
  const env = storeOptions?.env ?? process.env;
  const pathname = path.resolve(storeOptions?.path ?? resolveDurableRuntimeSqlitePath(env));
  const stateDatabaseLease = acquireOpenClawStateDatabaseLease({ env, path: pathname });
  const stateDatabase = stateDatabaseLease.database;
  const db = stateDatabase.db;
  const durableDb = (() => {
    try {
      return getNodeSqliteKysely<DurableRuntimeDatabase>(db);
    } catch (err) {
      stateDatabaseLease.release();
      closeOpenClawStateDatabaseForPath({ env, path: pathname });
      throw err;
    }
  })();
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
          queryFirst<DurableRuntimeRunRow>(
            db,
            durableDb
              .selectFrom("durable_runtime_runs")
              .selectAll()
              .where("operation_kind", "=", input.operationKind)
              .where("idempotency_key", "=", input.idempotencyKey),
          );
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
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_runs").values({
            runtime_run_id: runtimeRunId,
            operation_kind: input.operationKind,
            operation_version: operationVersion,
            idempotency_key: optionalText(input.idempotencyKey),
            request_hash: optionalText(input.requestHash),
            status,
            source_type: optionalText(input.sourceType),
            source_ref: optionalText(input.sourceRef),
            input_ref: optionalText(input.inputRef),
            created_at: now,
            updated_at: now,
            completed_at: input.completedAt ?? null,
            recovery_state: recoveryState,
            checkpoint_ref: optionalText(input.checkpointRef),
            parent_runtime_run_id: optionalText(input.parentRuntimeRunId),
            parent_step_id: optionalText(input.parentStepId),
            message_id: optionalText(input.messageId),
            turn_id: optionalText(input.turnId),
            work_unit_id: optionalText(input.workUnitId),
            report_route_id: optionalText(input.reportRouteId),
            claimed_by: null,
            claim_expires_at: null,
            heartbeat_at: null,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", runtimeRunId),
        );
        return rowToRun(row!);
      });
    },

    getRun(runtimeRunId: string): DurableRuntimeRun | undefined {
      const row = queryFirst<DurableRuntimeRunRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_runs")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId),
      );
      return row ? rowToRun(row) : undefined;
    },

    updateRun(input: UpdateDurableRuntimeRunInput): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
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
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_runs")
            .set({
              status: nextStatus,
              recovery_state: nextRecoveryState,
              updated_at: now,
              completed_at: completedAt,
              checkpoint_ref: nextCheckpointRef,
              work_unit_id: nextWorkUnitId,
              report_route_id: nextReportRouteId,
              claimed_by: nextClaimedBy,
              claim_expires_at: nextClaimExpiresAt,
              heartbeat_at: nextHeartbeatAt,
              metadata_json: nextMetadataJson,
            })
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        const row = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        return rowToRun(row!);
      });
    },

    appendEvent(input: AppendDurableRuntimeEventInput): DurableRuntimeEvent {
      const now = input.eventTime ?? Date.now();
      const recordedAt = Date.now();
      const eventId = input.eventId ?? `evt_${randomUUID()}`;
      return runSqliteImmediateTransactionSync(db, () => {
        const latestEvent = queryFirst<Pick<DurableRuntimeEventRow, "event_seq">>(
          db,
          durableDb
            .selectFrom("durable_runtime_events")
            .select("event_seq")
            .where("runtime_run_id", "=", input.runtimeRunId)
            .orderBy("event_seq", "desc")
            .limit(1),
        );
        const nextSeq = (latestEvent?.event_seq ?? 0) + 1;
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_events").values({
            event_id: eventId,
            runtime_run_id: input.runtimeRunId,
            event_seq: nextSeq,
            event_type: input.eventType,
            event_time: now,
            step_id: optionalText(input.stepId),
            agent_invocation_id: optionalText(input.agentInvocationId),
            tool_invocation_id: optionalText(input.toolInvocationId),
            idempotency_key: optionalText(input.idempotencyKey),
            payload_json: serializeJson(input.payload),
            payload_hash: optionalText(input.payloadHash),
            checkpoint_ref: optionalText(input.checkpointRef),
            causation_event_id: optionalText(input.causationEventId),
            correlation_id: optionalText(input.correlationId),
            recorded_at: recordedAt,
          }),
        );
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_runs")
            .set({ updated_at: recordedAt })
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        const row = queryFirst<DurableRuntimeEventRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_events")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("event_seq", "=", nextSeq),
        );
        return rowToEvent(row!);
      });
    },

    listRuns(options?: { limit?: number }): DurableRuntimeRun[] {
      const limit = Math.max(1, Math.min(500, Math.trunc(options?.limit ?? 50)));
      const rows = queryRows<DurableRuntimeRunRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_runs")
          .selectAll()
          .orderBy("updated_at", "desc")
          .orderBy("runtime_run_id", "desc")
          .limit(limit),
      );
      return rows.map(rowToRun);
    },

    listOpenRuns(options?: { operationKind?: string; limit?: number }): DurableRuntimeRun[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const operationKind = optionalText(options?.operationKind);
      const query = durableDb
        .selectFrom("durable_runtime_runs")
        .selectAll()
        .where("status", "not in", ["succeeded", "failed", "cancelled", "lost"])
        .$if(Boolean(operationKind), (qb) => qb.where("operation_kind", "=", operationKind!))
        .orderBy("updated_at", "asc")
        .orderBy("runtime_run_id", "asc")
        .limit(limit);
      return queryRows<DurableRuntimeRunRow>(db, query).map(rowToRun);
    },

    claimNextRunnableRun(input: ClaimDurableRuntimeRunInput): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const operationKind = optionalText(input.operationKind);
        const row = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .$if(Boolean(operationKind), (qb) => qb.where("operation_kind", "=", operationKind!))
            .where("status", "in", ["received", "queued"])
            .where("recovery_state", "in", ["runnable", "claimed"])
            .where((eb) =>
              eb.or([
                eb("claimed_by", "is", null),
                eb("claim_expires_at", "is", null),
                eb("claim_expires_at", "<=", now),
              ]),
            )
            .orderBy("updated_at", "asc")
            .orderBy("runtime_run_id", "asc")
            .limit(1),
        );
        if (!row) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_runs")
            .set({
              status: "queued",
              recovery_state: "claimed",
              claimed_by: input.workerId,
              claim_expires_at: claimExpiresAt,
              heartbeat_at: now,
              updated_at: now,
            })
            .where("runtime_run_id", "=", row.runtime_run_id),
        );
        const claimed = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", row.runtime_run_id),
        );
        return rowToRun(claimed!);
      });
    },

    releaseRunClaim(input: {
      runtimeRunId: string;
      workerId: string;
      now?: number;
    }): DurableRuntimeRun | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("claimed_by", "=", input.workerId)
            .where("status", "not in", ["succeeded", "failed", "cancelled", "lost"])
            .where("recovery_state", "!=", "terminal")
            .where("completed_at", "is", null),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_runs")
            .set({
              recovery_state: "runnable",
              claimed_by: null,
              claim_expires_at: null,
              heartbeat_at: null,
              updated_at: now,
            })
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        const row = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
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
          queryFirst<DurableRuntimeStepRow>(
            db,
            durableDb
              .selectFrom("durable_runtime_steps")
              .selectAll()
              .where("runtime_run_id", "=", input.runtimeRunId)
              .where("idempotency_key", "=", input.idempotencyKey),
          );
        if (existing) {
          return rowToStep(existing);
        }
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_steps").values({
            runtime_run_id: input.runtimeRunId,
            step_id: stepId,
            parent_step_id: optionalText(input.parentStepId),
            step_type: input.stepType,
            status,
            recovery_state: recoveryState,
            attempt,
            max_attempts: input.maxAttempts ?? null,
            idempotency_key: optionalText(input.idempotencyKey),
            input_ref: optionalText(input.inputRef),
            output_ref: optionalText(input.outputRef),
            error_ref: optionalText(input.errorRef),
            checkpoint_ref: optionalText(input.checkpointRef),
            claimed_by: null,
            claim_expires_at: null,
            heartbeat_at: null,
            created_at: now,
            started_at: status === "running" ? now : null,
            updated_at: now,
            completed_at: null,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", stepId),
        );
        return rowToStep(row!);
      });
    },

    updateStep(input: UpdateDurableRuntimeStepInput): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
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
        if (expectedClaimedBy && current.claimed_by !== expectedClaimedBy) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_steps")
            .set({
              status: nextStatus,
              recovery_state: nextRecoveryState,
              attempt: nextAttempt,
              max_attempts: nextMaxAttempts,
              input_ref: nextInputRef,
              output_ref: nextOutputRef,
              error_ref: nextErrorRef,
              checkpoint_ref: nextCheckpointRef,
              claimed_by: nextClaimedBy,
              claim_expires_at: nextClaimExpiresAt,
              heartbeat_at: nextHeartbeatAt,
              started_at: nextStartedAt,
              completed_at: nextCompletedAt,
              updated_at: now,
              metadata_json: nextMetadataJson,
            })
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        return rowToStep(row!);
      });
    },

    claimNextRunnableStep(input: ClaimDurableRuntimeStepInput): DurableRuntimeStep | undefined {
      const now = input.now ?? Date.now();
      const claimExpiresAt = now + input.claimTtlMs;
      return runSqliteImmediateTransactionSync(db, () => {
        const operationKind = optionalText(input.operationKind);
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps as s")
            .innerJoin("durable_runtime_runs as r", "r.runtime_run_id", "s.runtime_run_id")
            .selectAll("s")
            .where("s.status", "in", ["pending", "queued"])
            .where("s.recovery_state", "in", ["runnable", "claimed"])
            .where((eb) =>
              eb.or([
                eb("s.claimed_by", "is", null),
                eb("s.claim_expires_at", "is", null),
                eb("s.claim_expires_at", "<=", now),
              ]),
            )
            .where("r.status", "not in", ["succeeded", "failed", "cancelled", "lost"])
            .$if(Boolean(operationKind), (qb) => qb.where("r.operation_kind", "=", operationKind!))
            .$if(Boolean(input.stepType), (qb) => qb.where("s.step_type", "=", input.stepType!))
            .orderBy("s.updated_at", "asc")
            .orderBy("s.runtime_run_id", "asc")
            .orderBy("s.step_id", "asc")
            .limit(1),
        );
        if (!row) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_steps")
            .set({
              status: "queued",
              recovery_state: "claimed",
              claimed_by: input.workerId,
              claim_expires_at: claimExpiresAt,
              heartbeat_at: now,
              updated_at: now,
            })
            .where("runtime_run_id", "=", row.runtime_run_id)
            .where("step_id", "=", row.step_id),
        );
        const claimed = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .selectAll()
            .where("runtime_run_id", "=", row.runtime_run_id)
            .where("step_id", "=", row.step_id),
        );
        return rowToStep(claimed!);
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
        const current = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId)
            .where("claimed_by", "=", input.workerId)
            .where("status", "not in", ["succeeded", "failed", "cancelled", "lost", "skipped"])
            .where("recovery_state", "!=", "terminal")
            .where("completed_at", "is", null),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_steps")
            .set({
              status: current.status === "running" ? "queued" : current.status,
              recovery_state: "runnable",
              claimed_by: null,
              claim_expires_at: null,
              heartbeat_at: null,
              updated_at: now,
            })
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        const row = queryFirst<DurableRuntimeStepRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("step_id", "=", input.stepId),
        );
        return row ? rowToStep(row) : undefined;
      });
    },

    listSteps(runtimeRunId: string): DurableRuntimeStep[] {
      const rows = queryRows<DurableRuntimeStepRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_steps")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("step_id", "asc"),
      );
      return rows.map(rowToStep);
    },

    createRef(input: CreateDurableRuntimeRefInput): DurableRuntimeRef {
      const now = input.now ?? Date.now();
      const refId = input.refId ?? `ref_${randomUUID()}`;
      executeQuery(
        db,
        durableDb.insertInto("durable_runtime_refs").values({
          ref_id: refId,
          runtime_run_id: input.runtimeRunId,
          step_id: optionalText(input.stepId),
          ref_kind: input.refKind,
          media_type: optionalText(input.mediaType),
          hash: optionalText(input.hash),
          storage_kind: input.storageKind ?? "external",
          storage_uri: optionalText(input.storageUri),
          created_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableRuntimeRefRow>(
        db,
        durableDb.selectFrom("durable_runtime_refs").selectAll().where("ref_id", "=", refId),
      );
      return rowToRef(row!);
    },

    getRef(refId: string): DurableRuntimeRef | undefined {
      const row = queryFirst<DurableRuntimeRefRow>(
        db,
        durableDb.selectFrom("durable_runtime_refs").selectAll().where("ref_id", "=", refId),
      );
      return row ? rowToRef(row) : undefined;
    },

    listRefs(runtimeRunId: string): DurableRuntimeRef[] {
      const rows = queryRows<DurableRuntimeRefRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_refs")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("ref_id", "asc"),
      );
      return rows.map(rowToRef);
    },

    createLink(input: CreateDurableRuntimeLinkInput): DurableRuntimeLink {
      const now = input.now ?? Date.now();
      executeQuery(
        db,
        durableDb.insertInto("durable_runtime_links").values({
          parent_runtime_run_id: input.parentRuntimeRunId,
          parent_step_id: input.parentStepId,
          child_runtime_run_id: input.childRuntimeRunId,
          link_type: input.linkType,
          status: input.status ?? "pending",
          created_at: now,
          updated_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_links")
          .selectAll()
          .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
          .where("parent_step_id", "=", input.parentStepId)
          .where("child_runtime_run_id", "=", input.childRuntimeRunId),
      );
      return rowToLink(row!);
    },

    updateLink(input: UpdateDurableRuntimeLinkInput): DurableRuntimeLink | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeLinkRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_links")
            .selectAll()
            .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
            .where("parent_step_id", "=", input.parentStepId)
            .where("child_runtime_run_id", "=", input.childRuntimeRunId),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_links")
            .set({
              status: input.status ?? current.status,
              updated_at: now,
              metadata_json:
                input.metadata === undefined
                  ? current.metadata_json
                  : serializeJson(input.metadata),
            })
            .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
            .where("parent_step_id", "=", input.parentStepId)
            .where("child_runtime_run_id", "=", input.childRuntimeRunId),
        );
        const row = queryFirst<DurableRuntimeLinkRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_links")
            .selectAll()
            .where("parent_runtime_run_id", "=", input.parentRuntimeRunId)
            .where("parent_step_id", "=", input.parentStepId)
            .where("child_runtime_run_id", "=", input.childRuntimeRunId),
        );
        return rowToLink(row!);
      });
    },

    listChildLinks(parentRuntimeRunId: string): DurableRuntimeLink[] {
      const rows = queryRows<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_links")
          .selectAll()
          .where("parent_runtime_run_id", "=", parentRuntimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("child_runtime_run_id", "asc"),
      );
      return rows.map(rowToLink);
    },

    listParentLinks(childRuntimeRunId: string): DurableRuntimeLink[] {
      const rows = queryRows<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_links")
          .selectAll()
          .where("child_runtime_run_id", "=", childRuntimeRunId)
          .orderBy("created_at", "asc")
          .orderBy("parent_runtime_run_id", "asc")
          .orderBy("parent_step_id", "asc"),
      );
      return rows.map(rowToLink);
    },

    createTimer(input: CreateDurableRuntimeTimerInput): DurableRuntimeTimer {
      const now = input.now ?? Date.now();
      const timerId = input.timerId ?? `timer_${randomUUID()}`;
      executeQuery(
        db,
        durableDb.insertInto("durable_runtime_timers").values({
          timer_id: timerId,
          runtime_run_id: input.runtimeRunId,
          step_id: optionalText(input.stepId),
          timer_type: input.timerType,
          due_at: input.dueAt,
          status: "pending",
          created_at: now,
          fired_at: null,
          cancelled_at: null,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableRuntimeTimerRow>(
        db,
        durableDb.selectFrom("durable_runtime_timers").selectAll().where("timer_id", "=", timerId),
      );
      return rowToTimer(row!);
    },

    updateTimer(input: UpdateDurableRuntimeTimerInput): DurableRuntimeTimer | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeTimerRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_timers")
            .selectAll()
            .where("timer_id", "=", input.timerId),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_timers")
            .set({
              status: input.status,
              fired_at:
                input.firedAt === undefined
                  ? input.status === "fired"
                    ? now
                    : current.fired_at
                  : input.firedAt,
              cancelled_at:
                input.cancelledAt === undefined
                  ? input.status === "cancelled"
                    ? now
                    : current.cancelled_at
                  : input.cancelledAt,
            })
            .where("timer_id", "=", input.timerId),
        );
        const row = queryFirst<DurableRuntimeTimerRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_timers")
            .selectAll()
            .where("timer_id", "=", input.timerId),
        );
        return rowToTimer(row!);
      });
    },

    listTimers(runtimeRunId?: string): DurableRuntimeTimer[] {
      const rows = queryRows<DurableRuntimeTimerRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_timers")
          .selectAll()
          .$if(Boolean(runtimeRunId), (qb) => qb.where("runtime_run_id", "=", runtimeRunId!))
          .orderBy("due_at", "asc")
          .orderBy("timer_id", "asc"),
      );
      return rows.map(rowToTimer);
    },

    listDueTimers(now: number, options?: { limit?: number }): DurableRuntimeTimer[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = queryRows<DurableRuntimeTimerRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_timers")
          .selectAll()
          .where("status", "=", "pending")
          .where("due_at", "<=", now)
          .orderBy("due_at", "asc")
          .orderBy("timer_id", "asc")
          .limit(limit),
      );
      return rows.map(rowToTimer);
    },

    createSignal(input: CreateDurableRuntimeSignalInput): DurableRuntimeSignal {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          input.idempotencyKey &&
          queryFirst<DurableRuntimeSignalRow>(
            db,
            durableDb
              .selectFrom("durable_runtime_signals")
              .selectAll()
              .where("runtime_run_id", "=", input.runtimeRunId)
              .where("idempotency_key", "=", input.idempotencyKey),
          );
        if (existing) {
          return rowToSignal(existing);
        }
        const signalId = input.signalId ?? `sig_${randomUUID()}`;
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_signals").values({
            signal_id: signalId,
            runtime_run_id: input.runtimeRunId,
            step_id: optionalText(input.stepId),
            signal_type: input.signalType,
            idempotency_key: optionalText(input.idempotencyKey),
            payload_ref: optionalText(input.payloadRef),
            correlation_id: optionalText(input.correlationId),
            received_at: now,
            consumed_at: null,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableRuntimeSignalRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_signals")
            .selectAll()
            .where("signal_id", "=", signalId),
        );
        return rowToSignal(row!);
      });
    },

    consumeSignal(input: { signalId: string; now?: number }): DurableRuntimeSignal | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableRuntimeSignalRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_signals")
            .selectAll()
            .where("signal_id", "=", input.signalId),
        );
        if (!current) {
          return undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_signals")
            .set({ consumed_at: current.consumed_at ?? now })
            .where("signal_id", "=", input.signalId),
        );
        const row = queryFirst<DurableRuntimeSignalRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_signals")
            .selectAll()
            .where("signal_id", "=", input.signalId),
        );
        return row ? rowToSignal(row) : undefined;
      });
    },

    listPendingSignals(options?: { limit?: number }): DurableRuntimeSignal[] {
      const limit = Math.max(1, Math.min(5000, Math.trunc(options?.limit ?? 500)));
      const rows = queryRows<DurableRuntimeSignalRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_signals")
          .selectAll()
          .where("consumed_at", "is", null)
          .orderBy("received_at", "asc")
          .orderBy("signal_id", "asc")
          .limit(limit),
      );
      return rows.map(rowToSignal);
    },

    listSignals(runtimeRunId: string): DurableRuntimeSignal[] {
      const rows = queryRows<DurableRuntimeSignalRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_signals")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .orderBy("received_at", "asc")
          .orderBy("signal_id", "asc"),
      );
      return rows.map(rowToSignal);
    },

    getTimeline(
      runtimeRunId: string,
      timelineOptions?: DurableRuntimeTimelineOptions,
    ): DurableRuntimeEvent[] {
      const afterEventSeq = Math.max(0, Math.trunc(timelineOptions?.afterEventSeq ?? 0));
      const shouldLimit = timelineOptions?.limit !== undefined || afterEventSeq !== 0;
      const rows = queryRows<DurableRuntimeEventRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_events")
          .selectAll()
          .where("runtime_run_id", "=", runtimeRunId)
          .$if(afterEventSeq !== 0, (qb) => qb.where("event_seq", ">", afterEventSeq))
          .orderBy("event_seq", "asc")
          .$if(shouldLimit, (qb) => qb.limit(normalizeQueryLimit(timelineOptions?.limit, 500))),
      );
      return rows.map(rowToEvent);
    },

    compactTerminalRun(input: CompactDurableRuntimeRunInput): CompactDurableRuntimeRunResult {
      const keepLastEvents = normalizeQueryLimit(input.keepLastEvents, 200);
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const run = queryFirst<DurableRuntimeRunRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .selectAll()
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        if (!run || !isTerminalRunStatus(run.status)) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const totalEvents = count(
          db,
          durableDb
            .selectFrom("durable_runtime_events")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("runtime_run_id", "=", input.runtimeRunId),
        );
        if (totalEvents <= keepLastEvents) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const cutoff = queryFirst<{ event_seq: number | bigint }>(
          db,
          durableDb
            .selectFrom("durable_runtime_events")
            .select("event_seq")
            .where("runtime_run_id", "=", input.runtimeRunId)
            .orderBy("event_seq", "desc")
            .limit(1)
            .offset(keepLastEvents - 1),
        );
        const cutoffSeq = Number(cutoff?.event_seq ?? 0);
        if (cutoffSeq <= 1) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const removedEvents = executeQuery(
          db,
          durableDb
            .deleteFrom("durable_runtime_events")
            .where("runtime_run_id", "=", input.runtimeRunId)
            .where("event_seq", "<", cutoffSeq),
        );
        if (removedEvents <= 0) {
          return {
            runtimeRunId: input.runtimeRunId,
            compacted: false,
            removedEvents: 0,
          };
        }
        const nextSeq =
          (queryFirst<Pick<DurableRuntimeEventRow, "event_seq">>(
            db,
            durableDb
              .selectFrom("durable_runtime_events")
              .select("event_seq")
              .where("runtime_run_id", "=", input.runtimeRunId)
              .orderBy("event_seq", "desc")
              .limit(1),
          )?.event_seq ?? 0) + 1;
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_events").values({
            event_id: `evt_${randomUUID()}`,
            runtime_run_id: input.runtimeRunId,
            event_seq: nextSeq,
            event_type: "runtime.history.compacted",
            event_time: now,
            step_id: null,
            agent_invocation_id: null,
            tool_invocation_id: null,
            idempotency_key: null,
            payload_json: serializeJson({
              removedEvents,
              keptLastEvents: keepLastEvents,
              compactedBeforeEventSeq: cutoffSeq,
            }),
            payload_hash: null,
            checkpoint_ref: null,
            causation_event_id: null,
            correlation_id: null,
            recorded_at: now,
          }),
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
        runs: count(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .select((eb) => eb.fn.countAll<number>().as("count")),
        ),
        events: count(
          db,
          durableDb
            .selectFrom("durable_runtime_events")
            .select((eb) => eb.fn.countAll<number>().as("count")),
        ),
        steps: count(
          db,
          durableDb
            .selectFrom("durable_runtime_steps")
            .select((eb) => eb.fn.countAll<number>().as("count")),
        ),
        openRuns: count(
          db,
          durableDb
            .selectFrom("durable_runtime_runs")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("status", "not in", ["succeeded", "failed", "cancelled", "lost"]),
        ),
      };
    },

    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      stateDatabaseLease.release();
      closeOpenClawStateDatabaseForPath({ env, path: pathname });
    },
  };
}
