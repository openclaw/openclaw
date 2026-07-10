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
  CreateDurableParentWakeInput,
  CreateDurableWakeInput,
  CreateDurableRuntimeRefInput,
  CreateDurableRuntimeRunInput,
  CreateDurableRuntimeSignalInput,
  CreateDurableRuntimeStepInput,
  CreateDurableRuntimeTimerInput,
  CreateDurableSideEffectUncertaintyFactInput,
  DurableContinuationCleanupAudit,
  DurableContinuationCleanupStatus,
  DurableContinuationCleanupTargetKind,
  DurableDedupeLedgerEntry,
  DurableDedupeLedgerStatus,
  DurableDedupeScope,
  DurableParentWake,
  DurableParentWakeStatus,
  DurableWake,
  DurableWakeOwnerKind,
  DurableWakeStatus,
  DurableWakeTargetKind,
  DurableWakeTargetResolutionStatus,
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
  DurableSideEffectUncertaintyFact,
  DurableSideEffectUncertaintyStatus,
  DurableUnresolvedObligation,
  DurableWakeDeliveryAttempt,
  DurableWakeDeliveryAttemptStatus,
  UpdateDurableRuntimeRunInput,
  UpdateDurableRuntimeLinkInput,
  RecordDurableContinuationCleanupInput,
  RecordDurableDedupeLedgerInput,
  RecordDurableWakeDeliveryAttemptInput,
  ResolveDurableSideEffectUncertaintyFactInput,
  UpdateDurableParentWakeInput,
  UpdateDurableWakeDeliveryAttemptInput,
  UpdateDurableWakeInput,
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

type DurableParentWakeRow = {
  wake_id: string;
  parent_run_id: string | null;
  parent_session_key: string | null;
  target_agent: string | null;
  target_session: string | null;
  target_channel: string | null;
  target_kind: DurableWakeTargetKind | null;
  target_ref: string | null;
  owner_kind: DurableWakeOwnerKind | null;
  owner_ref: string | null;
  report_route_ref: string | null;
  target_resolution_status: DurableWakeTargetResolutionStatus | null;
  target_resolution_reason: string | null;
  reason: DurableParentWake["reason"];
  facts_ref: string | null;
  source_run_id: string | null;
  dedupe_key: string;
  attempt_count: number | bigint;
  last_attempt_at: number | bigint | null;
  acked_at: number | bigint | null;
  failed_reason: string | null;
  status: DurableParentWakeStatus;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type DurableSideEffectUncertaintyFactRow = {
  fact_id: string;
  kind: DurableSideEffectUncertaintyFact["kind"];
  source_run_id: string | null;
  step_id: string | null;
  event_id: string | null;
  ref_id: string | null;
  facts_ref: string | null;
  dedupe_key: string | null;
  facts_json: string | null;
  status: DurableSideEffectUncertaintyStatus;
  resolution_kind: string | null;
  resolution_ref: string | null;
  resolved_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type DurableContinuationCleanupAuditRow = {
  cleanup_id: string;
  target_kind: DurableContinuationCleanupTargetKind;
  target_id: string;
  runtime_run_id: string | null;
  step_id: string | null;
  superseded_by_ref: string | null;
  reason: string | null;
  requested_by: string | null;
  dedupe_key: string;
  status: DurableContinuationCleanupStatus;
  created_at: number | bigint;
  metadata_json: string | null;
};

type DurableDedupeLedgerEntryRow = {
  ledger_id: string;
  scope: DurableDedupeScope;
  dedupe_key: string;
  subject_ref: string | null;
  operation_kind: string | null;
  status: DurableDedupeLedgerStatus;
  first_seen_at: number | bigint;
  last_seen_at: number | bigint;
  hit_count: number | bigint;
  metadata_json: string | null;
};

type DurableWakeDeliveryAttemptRow = {
  delivery_attempt_id: string;
  wake_id: string;
  dedupe_key: string;
  replay_pass_id: string | null;
  target_kind: DurableWakeTargetKind | null;
  target_ref: string | null;
  route_kind: DurableWakeTargetKind | null;
  route_ref: string | null;
  status: DurableWakeDeliveryAttemptStatus;
  evidence_json: string | null;
  error_message: string | null;
  scheduled_at: number | bigint;
  attempted_at: number | bigint | null;
  delivered_at: number | bigint | null;
  failed_at: number | bigint | null;
  unknown_at: number | bigint | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type DurableUnresolvedObligationRow = {
  obligation_id: string;
  kind: DurableUnresolvedObligation["kind"];
  runtime_run_id: string | null;
  step_id: string | null;
  wake_id: string | null;
  uncertainty_fact_id: string | null;
  subject_ref: string | null;
  reason: string | null;
  status: string;
  created_at: number | bigint;
  updated_at: number | bigint;
  metadata_json: string | null;
};

type CountRow = { count: number | bigint };
type DurableRuntimeDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "durable_runtime_continuation_cleanup"
  | "durable_runtime_dedupe_ledger"
  | "durable_runtime_events"
  | "durable_runtime_links"
  | "durable_runtime_parent_wakes"
  | "durable_runtime_refs"
  | "durable_runtime_runs"
  | "durable_runtime_signals"
  | "durable_runtime_steps"
  | "durable_runtime_timers"
  | "durable_runtime_uncertainty_facts"
  | "durable_runtime_wake_delivery_attempts"
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

function rowToParentWake(row: DurableParentWakeRow): DurableParentWake {
  return {
    wakeId: row.wake_id,
    ...(row.parent_run_id ? { parentRunId: row.parent_run_id } : {}),
    ...(row.parent_session_key ? { parentSessionKey: row.parent_session_key } : {}),
    ...(row.target_agent ? { targetAgent: row.target_agent } : {}),
    ...(row.target_session ? { targetSession: row.target_session } : {}),
    ...(row.target_channel ? { targetChannel: row.target_channel } : {}),
    ...(row.target_kind ? { targetKind: row.target_kind } : {}),
    ...(row.target_ref ? { targetRef: row.target_ref } : {}),
    ...(row.owner_kind ? { ownerKind: row.owner_kind } : {}),
    ...(row.owner_ref ? { ownerRef: row.owner_ref } : {}),
    ...(row.report_route_ref ? { reportRouteRef: row.report_route_ref } : {}),
    ...(row.target_resolution_status
      ? { targetResolutionStatus: row.target_resolution_status }
      : {}),
    ...(row.target_resolution_reason
      ? { targetResolutionReason: row.target_resolution_reason }
      : {}),
    reason: row.reason,
    ...(row.facts_ref ? { factsRef: row.facts_ref } : {}),
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    dedupeKey: row.dedupe_key,
    attemptCount: Number(row.attempt_count),
    ...(row.last_attempt_at == null ? {} : { lastAttemptAt: Number(row.last_attempt_at) }),
    ...(row.acked_at == null ? {} : { ackedAt: Number(row.acked_at) }),
    ...(row.failed_reason ? { failedReason: row.failed_reason } : {}),
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToUncertaintyFact(
  row: DurableSideEffectUncertaintyFactRow,
): DurableSideEffectUncertaintyFact {
  return {
    factId: row.fact_id,
    kind: row.kind,
    ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.event_id ? { eventId: row.event_id } : {}),
    ...(row.ref_id ? { refId: row.ref_id } : {}),
    ...(row.facts_ref ? { factsRef: row.facts_ref } : {}),
    ...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
    ...(row.facts_json ? { facts: parseJsonRecord(row.facts_json) } : {}),
    status: row.status,
    ...(row.resolution_kind ? { resolutionKind: row.resolution_kind } : {}),
    ...(row.resolution_ref ? { resolutionRef: row.resolution_ref } : {}),
    ...(row.resolved_at == null ? {} : { resolvedAt: Number(row.resolved_at) }),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToContinuationCleanupAudit(
  row: DurableContinuationCleanupAuditRow,
): DurableContinuationCleanupAudit {
  return {
    cleanupId: row.cleanup_id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    ...(row.runtime_run_id ? { runtimeRunId: row.runtime_run_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.superseded_by_ref ? { supersededByRef: row.superseded_by_ref } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.requested_by ? { requestedBy: row.requested_by } : {}),
    dedupeKey: row.dedupe_key,
    status: row.status,
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
    createdAt: Number(row.created_at),
  };
}

function rowToDedupeLedgerEntry(row: DurableDedupeLedgerEntryRow): DurableDedupeLedgerEntry {
  return {
    ledgerId: row.ledger_id,
    scope: row.scope,
    dedupeKey: row.dedupe_key,
    ...(row.subject_ref ? { subjectRef: row.subject_ref } : {}),
    ...(row.operation_kind ? { operationKind: row.operation_kind } : {}),
    status: row.status,
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    hitCount: Number(row.hit_count),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function rowToWakeDeliveryAttempt(row: DurableWakeDeliveryAttemptRow): DurableWakeDeliveryAttempt {
  return {
    deliveryAttemptId: row.delivery_attempt_id,
    wakeId: row.wake_id,
    dedupeKey: row.dedupe_key,
    ...(row.replay_pass_id ? { replayPassId: row.replay_pass_id } : {}),
    ...(row.target_kind ? { targetKind: row.target_kind } : {}),
    ...(row.target_ref ? { targetRef: row.target_ref } : {}),
    ...(row.route_kind ? { routeKind: row.route_kind } : {}),
    ...(row.route_ref ? { routeRef: row.route_ref } : {}),
    status: row.status,
    ...(row.evidence_json ? { evidence: parseJsonRecord(row.evidence_json) } : {}),
    ...(row.error_message ? { error: row.error_message } : {}),
    scheduledAt: Number(row.scheduled_at),
    ...(row.attempted_at == null ? {} : { attemptedAt: Number(row.attempted_at) }),
    ...(row.delivered_at == null ? {} : { deliveredAt: Number(row.delivered_at) }),
    ...(row.failed_at == null ? {} : { failedAt: Number(row.failed_at) }),
    ...(row.unknown_at == null ? {} : { unknownAt: Number(row.unknown_at) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
  };
}

function rowToUnresolvedObligation(
  row: DurableUnresolvedObligationRow,
): DurableUnresolvedObligation {
  return {
    obligationId: row.obligation_id,
    kind: row.kind,
    ...(row.runtime_run_id ? { runtimeRunId: row.runtime_run_id } : {}),
    ...(row.step_id ? { stepId: row.step_id } : {}),
    ...(row.wake_id ? { wakeId: row.wake_id } : {}),
    ...(row.uncertainty_fact_id ? { uncertaintyFactId: row.uncertainty_fact_id } : {}),
    ...(row.subject_ref ? { subjectRef: row.subject_ref } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    status: row.status,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.metadata_json ? { metadata: parseJsonRecord(row.metadata_json) } : {}),
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

function isTerminalWakeStatus(status: DurableParentWakeStatus): boolean {
  return status === "acked" || status === "superseded";
}

function isAllowedWakeStatusTransition(
  current: DurableParentWakeStatus,
  next: DurableParentWakeStatus,
): boolean {
  if (current === next) {
    return true;
  }
  if (current === "pending") {
    return next === "delivered" || next === "acked" || next === "failed" || next === "superseded";
  }
  if (current === "delivered") {
    return next === "acked" || next === "failed" || next === "superseded";
  }
  if (current === "failed") {
    return next === "superseded";
  }
  return false;
}

function isSameSqlValue(
  left: string | number | bigint | null,
  right: string | number | bigint | null,
): boolean {
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

  const createDurableWakeRecord = (
    input: CreateDurableWakeInput,
    options?: { requireParentTarget?: boolean },
  ): DurableWake => {
    const parentRunId = optionalText(input.parentRunId);
    const parentSessionKey = optionalText(input.parentSessionKey);
    if (options?.requireParentTarget && !parentRunId && !parentSessionKey) {
      throw new Error("Durable parent wake requires parentRunId or parentSessionKey");
    }
    const targetRef = optionalText(input.targetRef);
    const reportRouteRef = optionalText(input.reportRouteRef);
    const targetResolutionStatus = input.targetResolutionStatus;
    const hasInspectableResolution =
      targetResolutionStatus === "ambiguous" ||
      targetResolutionStatus === "missing" ||
      targetResolutionStatus === "unauthorized" ||
      targetResolutionStatus === "inspect_only";
    if (
      !parentRunId &&
      !parentSessionKey &&
      !targetRef &&
      !reportRouteRef &&
      !hasInspectableResolution
    ) {
      throw new Error(
        "Durable wake requires a parent target, generalized target, report route, or inspect-only resolution",
      );
    }
    const dedupeKey = optionalText(input.dedupeKey);
    if (!dedupeKey) {
      throw new Error("Durable wake requires a dedupeKey");
    }
    const now = input.now ?? Date.now();
    const wakeId = input.wakeId ?? `wake_${randomUUID()}`;
    return runSqliteImmediateTransactionSync(db, () => {
      const existing = queryFirst<DurableParentWakeRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_parent_wakes")
          .selectAll()
          .where("dedupe_key", "=", dedupeKey),
      );
      if (existing) {
        return rowToParentWake(existing);
      }
      executeQuery(
        db,
        durableDb.insertInto("durable_runtime_parent_wakes").values({
          wake_id: wakeId,
          parent_run_id: parentRunId,
          parent_session_key: parentSessionKey,
          target_agent: optionalText(input.targetAgent),
          target_session: optionalText(input.targetSession),
          target_channel: optionalText(input.targetChannel),
          target_kind: optionalText(input.targetKind),
          target_ref: targetRef,
          owner_kind: optionalText(input.ownerKind),
          owner_ref: optionalText(input.ownerRef),
          report_route_ref: reportRouteRef,
          target_resolution_status: optionalText(input.targetResolutionStatus),
          target_resolution_reason: optionalText(input.targetResolutionReason),
          reason: input.reason,
          facts_ref: optionalText(input.factsRef),
          source_run_id: optionalText(input.sourceRunId),
          dedupe_key: dedupeKey,
          attempt_count: 0,
          last_attempt_at: null,
          acked_at: null,
          failed_reason: null,
          status: "pending",
          created_at: now,
          updated_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      const row = queryFirst<DurableParentWakeRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_parent_wakes")
          .selectAll()
          .where("wake_id", "=", wakeId),
      );
      return rowToParentWake(row!);
    });
  };

  const updateDurableWakeRecord = (input: UpdateDurableWakeInput): DurableWake | undefined => {
    const now = input.now ?? Date.now();
    return runSqliteImmediateTransactionSync(db, () => {
      const current = queryFirst<DurableParentWakeRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_parent_wakes")
          .selectAll()
          .where("wake_id", "=", input.wakeId),
      );
      if (!current) {
        return undefined;
      }
      const nextAttemptCount = input.attemptCount ?? current.attempt_count;
      const nextLastAttemptAt =
        input.lastAttemptAt === undefined ? current.last_attempt_at : input.lastAttemptAt;
      const nextAckedAt = input.ackedAt === undefined ? current.acked_at : input.ackedAt;
      const nextFailedReason =
        input.failedReason === undefined
          ? current.failed_reason
          : optionalText(input.failedReason ?? undefined);
      const nextMetadataJson =
        input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
      if (isTerminalWakeStatus(current.status)) {
        const isNoOp =
          input.status === current.status &&
          isSameSqlValue(nextAttemptCount, current.attempt_count) &&
          isSameSqlValue(nextLastAttemptAt, current.last_attempt_at) &&
          isSameSqlValue(nextAckedAt, current.acked_at) &&
          isSameSqlValue(nextFailedReason, current.failed_reason) &&
          isSameSqlValue(nextMetadataJson, current.metadata_json);
        return isNoOp ? rowToParentWake(current) : undefined;
      }
      if (!isAllowedWakeStatusTransition(current.status, input.status)) {
        return undefined;
      }
      executeQuery(
        db,
        durableDb
          .updateTable("durable_runtime_parent_wakes")
          .set({
            status: input.status,
            attempt_count: Number(nextAttemptCount),
            last_attempt_at: nextLastAttemptAt == null ? null : Number(nextLastAttemptAt),
            acked_at: nextAckedAt == null ? null : Number(nextAckedAt),
            failed_reason: nextFailedReason,
            updated_at: now,
            metadata_json: nextMetadataJson,
          })
          .where("wake_id", "=", input.wakeId),
      );
      const row = queryFirst<DurableParentWakeRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_parent_wakes")
          .selectAll()
          .where("wake_id", "=", input.wakeId),
      );
      return rowToParentWake(row!);
    });
  };

  const getDurableWakeRecord = (wakeId: string): DurableWake | undefined => {
    const row = queryFirst<DurableParentWakeRow>(
      db,
      durableDb
        .selectFrom("durable_runtime_parent_wakes")
        .selectAll()
        .where("wake_id", "=", wakeId),
    );
    return row ? rowToParentWake(row) : undefined;
  };

  const listDurableWakeRecords = (options?: {
    parentRunId?: string;
    parentSessionKey?: string;
    targetKind?: DurableWakeTargetKind;
    targetRef?: string;
    ownerKind?: DurableWakeOwnerKind;
    ownerRef?: string;
    reportRouteRef?: string;
    targetResolutionStatus?: DurableWakeTargetResolutionStatus;
    status?: DurableWakeStatus;
    limit?: number;
  }): DurableWake[] => {
    const parentRunId = optionalText(options?.parentRunId);
    const parentSessionKey = optionalText(options?.parentSessionKey);
    const targetRef = optionalText(options?.targetRef);
    const ownerRef = optionalText(options?.ownerRef);
    const reportRouteRef = optionalText(options?.reportRouteRef);
    const rows = queryRows<DurableParentWakeRow>(
      db,
      durableDb
        .selectFrom("durable_runtime_parent_wakes")
        .selectAll()
        .$if(Boolean(parentRunId), (qb) => qb.where("parent_run_id", "=", parentRunId!))
        .$if(Boolean(parentSessionKey), (qb) =>
          qb.where("parent_session_key", "=", parentSessionKey!),
        )
        .$if(Boolean(options?.targetKind), (qb) =>
          qb.where("target_kind", "=", options!.targetKind!),
        )
        .$if(Boolean(targetRef), (qb) => qb.where("target_ref", "=", targetRef!))
        .$if(Boolean(options?.ownerKind), (qb) => qb.where("owner_kind", "=", options!.ownerKind!))
        .$if(Boolean(ownerRef), (qb) => qb.where("owner_ref", "=", ownerRef!))
        .$if(Boolean(reportRouteRef), (qb) => qb.where("report_route_ref", "=", reportRouteRef!))
        .$if(Boolean(options?.targetResolutionStatus), (qb) =>
          qb.where("target_resolution_status", "=", options!.targetResolutionStatus!),
        )
        .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
        .orderBy("updated_at", "desc")
        .orderBy("wake_id", "desc")
        .limit(normalizeQueryLimit(options?.limit, 500)),
    );
    return rows.map(rowToParentWake);
  };

  const recordWakeDeliveryAttemptRecord = (
    input: RecordDurableWakeDeliveryAttemptInput,
  ): DurableWakeDeliveryAttempt => {
    const now = input.now ?? Date.now();
    const deliveryAttemptId = input.deliveryAttemptId ?? `wake_delivery_${randomUUID()}`;
    const dedupeKey = optionalText(input.dedupeKey);
    if (!dedupeKey) {
      throw new Error("Durable wake delivery attempt requires a dedupeKey");
    }
    return runSqliteImmediateTransactionSync(db, () => {
      const existing = queryFirst<DurableWakeDeliveryAttemptRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_wake_delivery_attempts")
          .selectAll()
          .where("dedupe_key", "=", dedupeKey),
      );
      if (existing) {
        return rowToWakeDeliveryAttempt(existing);
      }
      const wake = queryFirst<DurableParentWakeRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_parent_wakes")
          .selectAll()
          .where("wake_id", "=", input.wakeId),
      );
      if (!wake) {
        throw new Error(`Durable wake delivery attempt references unknown wake ${input.wakeId}`);
      }
      executeQuery(
        db,
        durableDb.insertInto("durable_runtime_wake_delivery_attempts").values({
          delivery_attempt_id: deliveryAttemptId,
          wake_id: input.wakeId,
          dedupe_key: dedupeKey,
          replay_pass_id: optionalText(input.replayPassId),
          target_kind: optionalText(input.targetKind),
          target_ref: optionalText(input.targetRef),
          route_kind: optionalText(input.routeKind),
          route_ref: optionalText(input.routeRef),
          status: input.status ?? "pending",
          evidence_json: serializeJson(input.evidence),
          error_message: optionalText(input.error),
          scheduled_at: now,
          attempted_at: input.attemptedAt ?? null,
          delivered_at: input.deliveredAt ?? null,
          failed_at: input.failedAt ?? null,
          unknown_at: input.unknownAt ?? null,
          created_at: now,
          updated_at: now,
          metadata_json: serializeJson(input.metadata),
        }),
      );
      executeQuery(
        db,
        durableDb
          .updateTable("durable_runtime_parent_wakes")
          .set({
            attempt_count: Number(wake.attempt_count) + 1,
            last_attempt_at: now,
            updated_at: now,
          })
          .where("wake_id", "=", input.wakeId),
      );
      const row = queryFirst<DurableWakeDeliveryAttemptRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_wake_delivery_attempts")
          .selectAll()
          .where("delivery_attempt_id", "=", deliveryAttemptId),
      );
      return rowToWakeDeliveryAttempt(row!);
    });
  };

  const updateWakeDeliveryAttemptRecord = (
    input: UpdateDurableWakeDeliveryAttemptInput,
  ): DurableWakeDeliveryAttempt | undefined => {
    const now = input.now ?? Date.now();
    return runSqliteImmediateTransactionSync(db, () => {
      const current = queryFirst<DurableWakeDeliveryAttemptRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_wake_delivery_attempts")
          .selectAll()
          .where("delivery_attempt_id", "=", input.deliveryAttemptId),
      );
      if (!current) {
        return undefined;
      }
      const nextEvidenceJson =
        input.evidence === undefined ? current.evidence_json : serializeJson(input.evidence);
      const nextError =
        input.error === undefined ? current.error_message : optionalText(input.error ?? undefined);
      const nextAttemptedAt =
        input.attemptedAt === undefined ? current.attempted_at : input.attemptedAt;
      const nextDeliveredAt =
        input.deliveredAt === undefined ? current.delivered_at : input.deliveredAt;
      const nextFailedAt = input.failedAt === undefined ? current.failed_at : input.failedAt;
      const nextUnknownAt = input.unknownAt === undefined ? current.unknown_at : input.unknownAt;
      const nextMetadataJson =
        input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata);
      executeQuery(
        db,
        durableDb
          .updateTable("durable_runtime_wake_delivery_attempts")
          .set({
            status: input.status,
            evidence_json: nextEvidenceJson,
            error_message: nextError,
            attempted_at: nextAttemptedAt == null ? null : Number(nextAttemptedAt),
            delivered_at: nextDeliveredAt == null ? null : Number(nextDeliveredAt),
            failed_at: nextFailedAt == null ? null : Number(nextFailedAt),
            unknown_at: nextUnknownAt == null ? null : Number(nextUnknownAt),
            updated_at: now,
            metadata_json: nextMetadataJson,
          })
          .where("delivery_attempt_id", "=", input.deliveryAttemptId),
      );
      const row = queryFirst<DurableWakeDeliveryAttemptRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_wake_delivery_attempts")
          .selectAll()
          .where("delivery_attempt_id", "=", input.deliveryAttemptId),
      );
      return rowToWakeDeliveryAttempt(row!);
    });
  };

  const getWakeDeliveryAttemptRecord = (
    deliveryAttemptId: string,
  ): DurableWakeDeliveryAttempt | undefined => {
    const row = queryFirst<DurableWakeDeliveryAttemptRow>(
      db,
      durableDb
        .selectFrom("durable_runtime_wake_delivery_attempts")
        .selectAll()
        .where("delivery_attempt_id", "=", deliveryAttemptId),
    );
    return row ? rowToWakeDeliveryAttempt(row) : undefined;
  };

  const listWakeDeliveryAttemptRecords = (options?: {
    wakeId?: string;
    dedupeKey?: string;
    status?: DurableWakeDeliveryAttemptStatus;
    limit?: number;
  }): DurableWakeDeliveryAttempt[] => {
    const wakeId = optionalText(options?.wakeId);
    const dedupeKey = optionalText(options?.dedupeKey);
    const rows = queryRows<DurableWakeDeliveryAttemptRow>(
      db,
      durableDb
        .selectFrom("durable_runtime_wake_delivery_attempts")
        .selectAll()
        .$if(Boolean(wakeId), (qb) => qb.where("wake_id", "=", wakeId!))
        .$if(Boolean(dedupeKey), (qb) => qb.where("dedupe_key", "=", dedupeKey!))
        .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
        .orderBy("scheduled_at", "desc")
        .orderBy("delivery_attempt_id", "desc")
        .limit(normalizeQueryLimit(options?.limit, 500)),
    );
    return rows.map(rowToWakeDeliveryAttempt);
  };

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

    createDurableWake(input: CreateDurableWakeInput): DurableWake {
      return createDurableWakeRecord(input);
    },

    updateDurableWake(input: UpdateDurableWakeInput): DurableWake | undefined {
      return updateDurableWakeRecord(input);
    },

    getDurableWake(wakeId: string): DurableWake | undefined {
      return getDurableWakeRecord(wakeId);
    },

    listDurableWakes(options?: {
      parentRunId?: string;
      parentSessionKey?: string;
      targetKind?: DurableWakeTargetKind;
      targetRef?: string;
      ownerKind?: DurableWakeOwnerKind;
      ownerRef?: string;
      reportRouteRef?: string;
      targetResolutionStatus?: DurableWakeTargetResolutionStatus;
      status?: DurableWakeStatus;
      limit?: number;
    }): DurableWake[] {
      return listDurableWakeRecords(options);
    },

    createParentWake(input: CreateDurableParentWakeInput): DurableParentWake {
      return createDurableWakeRecord(input, { requireParentTarget: true });
    },

    updateParentWake(input: UpdateDurableParentWakeInput): DurableParentWake | undefined {
      return updateDurableWakeRecord(input);
    },

    getParentWake(wakeId: string): DurableParentWake | undefined {
      return getDurableWakeRecord(wakeId);
    },

    listParentWakes(options?: {
      parentRunId?: string;
      parentSessionKey?: string;
      status?: DurableParentWakeStatus;
      limit?: number;
    }): DurableParentWake[] {
      return listDurableWakeRecords(options);
    },

    recordSideEffectUncertaintyFact(
      input: CreateDurableSideEffectUncertaintyFactInput,
    ): DurableSideEffectUncertaintyFact {
      const now = input.now ?? Date.now();
      const factId = input.factId ?? `uncertain_${randomUUID()}`;
      const dedupeKey = optionalText(input.dedupeKey);
      return runSqliteImmediateTransactionSync(db, () => {
        const existing =
          dedupeKey &&
          queryFirst<DurableSideEffectUncertaintyFactRow>(
            db,
            durableDb
              .selectFrom("durable_runtime_uncertainty_facts")
              .selectAll()
              .where("dedupe_key", "=", dedupeKey),
          );
        if (existing) {
          return rowToUncertaintyFact(existing);
        }
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_uncertainty_facts").values({
            fact_id: factId,
            kind: input.kind,
            source_run_id: optionalText(input.sourceRunId),
            step_id: optionalText(input.stepId),
            event_id: optionalText(input.eventId),
            ref_id: optionalText(input.refId),
            facts_ref: optionalText(input.factsRef),
            dedupe_key: dedupeKey,
            facts_json: serializeJson(input.facts),
            status: "open",
            resolution_kind: null,
            resolution_ref: null,
            resolved_at: null,
            created_at: now,
            updated_at: now,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableSideEffectUncertaintyFactRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_uncertainty_facts")
            .selectAll()
            .where("fact_id", "=", factId),
        );
        return rowToUncertaintyFact(row!);
      });
    },

    resolveSideEffectUncertaintyFact(
      input: ResolveDurableSideEffectUncertaintyFactInput,
    ): DurableSideEffectUncertaintyFact | undefined {
      const now = input.now ?? Date.now();
      return runSqliteImmediateTransactionSync(db, () => {
        const current = queryFirst<DurableSideEffectUncertaintyFactRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_uncertainty_facts")
            .selectAll()
            .where("fact_id", "=", input.factId),
        );
        if (!current) {
          return undefined;
        }
        if (current.status !== "open") {
          const isNoOp =
            input.status === current.status &&
            isSameSqlValue(optionalText(input.resolutionKind), current.resolution_kind) &&
            isSameSqlValue(optionalText(input.resolutionRef), current.resolution_ref) &&
            isSameSqlValue(
              input.metadata === undefined ? current.metadata_json : serializeJson(input.metadata),
              current.metadata_json,
            );
          return isNoOp ? rowToUncertaintyFact(current) : undefined;
        }
        executeQuery(
          db,
          durableDb
            .updateTable("durable_runtime_uncertainty_facts")
            .set({
              status: input.status,
              resolution_kind: optionalText(input.resolutionKind),
              resolution_ref: optionalText(input.resolutionRef),
              resolved_at: now,
              updated_at: now,
              metadata_json:
                input.metadata === undefined
                  ? current.metadata_json
                  : serializeJson(input.metadata),
            })
            .where("fact_id", "=", input.factId),
        );
        const row = queryFirst<DurableSideEffectUncertaintyFactRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_uncertainty_facts")
            .selectAll()
            .where("fact_id", "=", input.factId),
        );
        return rowToUncertaintyFact(row!);
      });
    },

    listSideEffectUncertaintyFacts(options?: {
      sourceRunId?: string;
      status?: DurableSideEffectUncertaintyStatus;
      limit?: number;
    }): DurableSideEffectUncertaintyFact[] {
      const sourceRunId = optionalText(options?.sourceRunId);
      const rows = queryRows<DurableSideEffectUncertaintyFactRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_uncertainty_facts")
          .selectAll()
          .$if(Boolean(sourceRunId), (qb) => qb.where("source_run_id", "=", sourceRunId!))
          .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
          .orderBy("updated_at", "desc")
          .orderBy("fact_id", "desc")
          .limit(normalizeQueryLimit(options?.limit, 500)),
      );
      return rows.map(rowToUncertaintyFact);
    },

    recordContinuationCleanup(
      input: RecordDurableContinuationCleanupInput,
    ): DurableContinuationCleanupAudit {
      const now = input.now ?? Date.now();
      const cleanupId = input.cleanupId ?? `cleanup_${randomUUID()}`;
      const dedupeKey = optionalText(input.dedupeKey);
      if (!dedupeKey) {
        throw new Error("Durable continuation cleanup requires a dedupeKey");
      }
      return runSqliteImmediateTransactionSync(db, () => {
        const existing = queryFirst<DurableContinuationCleanupAuditRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_continuation_cleanup")
            .selectAll()
            .where("dedupe_key", "=", dedupeKey),
        );
        if (existing) {
          return rowToContinuationCleanupAudit(existing);
        }
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_continuation_cleanup").values({
            cleanup_id: cleanupId,
            target_kind: input.targetKind,
            target_id: input.targetId,
            runtime_run_id: optionalText(input.runtimeRunId),
            step_id: optionalText(input.stepId),
            superseded_by_ref: optionalText(input.supersededByRef),
            reason: optionalText(input.reason),
            requested_by: optionalText(input.requestedBy),
            dedupe_key: dedupeKey,
            status: input.status ?? "superseded",
            created_at: now,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableContinuationCleanupAuditRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_continuation_cleanup")
            .selectAll()
            .where("cleanup_id", "=", cleanupId),
        );
        return rowToContinuationCleanupAudit(row!);
      });
    },

    listContinuationCleanupAudit(options?: {
      runtimeRunId?: string;
      targetKind?: DurableContinuationCleanupTargetKind;
      limit?: number;
    }): DurableContinuationCleanupAudit[] {
      const runtimeRunId = optionalText(options?.runtimeRunId);
      const rows = queryRows<DurableContinuationCleanupAuditRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_continuation_cleanup")
          .selectAll()
          .$if(Boolean(runtimeRunId), (qb) => qb.where("runtime_run_id", "=", runtimeRunId!))
          .$if(Boolean(options?.targetKind), (qb) =>
            qb.where("target_kind", "=", options!.targetKind!),
          )
          .orderBy("created_at", "desc")
          .orderBy("cleanup_id", "desc")
          .limit(normalizeQueryLimit(options?.limit, 500)),
      );
      return rows.map(rowToContinuationCleanupAudit);
    },

    recordDedupeLedgerEntry(input: RecordDurableDedupeLedgerInput): DurableDedupeLedgerEntry {
      const now = input.now ?? Date.now();
      const ledgerId = input.ledgerId ?? `dedupe_${randomUUID()}`;
      const dedupeKey = optionalText(input.dedupeKey);
      if (!dedupeKey) {
        throw new Error("Durable dedupe ledger requires a dedupeKey");
      }
      return runSqliteImmediateTransactionSync(db, () => {
        const existing = queryFirst<DurableDedupeLedgerEntryRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_dedupe_ledger")
            .selectAll()
            .where("scope", "=", input.scope)
            .where("dedupe_key", "=", dedupeKey),
        );
        if (existing) {
          executeQuery(
            db,
            durableDb
              .updateTable("durable_runtime_dedupe_ledger")
              .set({ last_seen_at: now, hit_count: Number(existing.hit_count) + 1 })
              .where("ledger_id", "=", existing.ledger_id),
          );
          const row = queryFirst<DurableDedupeLedgerEntryRow>(
            db,
            durableDb
              .selectFrom("durable_runtime_dedupe_ledger")
              .selectAll()
              .where("ledger_id", "=", existing.ledger_id),
          );
          return rowToDedupeLedgerEntry(row!);
        }
        executeQuery(
          db,
          durableDb.insertInto("durable_runtime_dedupe_ledger").values({
            ledger_id: ledgerId,
            scope: input.scope,
            dedupe_key: dedupeKey,
            subject_ref: optionalText(input.subjectRef),
            operation_kind: optionalText(input.operationKind),
            status: input.status ?? "recorded",
            first_seen_at: now,
            last_seen_at: now,
            hit_count: 1,
            metadata_json: serializeJson(input.metadata),
          }),
        );
        const row = queryFirst<DurableDedupeLedgerEntryRow>(
          db,
          durableDb
            .selectFrom("durable_runtime_dedupe_ledger")
            .selectAll()
            .where("ledger_id", "=", ledgerId),
        );
        return rowToDedupeLedgerEntry(row!);
      });
    },

    listDedupeLedgerEntries(options?: {
      scope?: DurableDedupeScope;
      status?: DurableDedupeLedgerStatus;
      limit?: number;
    }): DurableDedupeLedgerEntry[] {
      const rows = queryRows<DurableDedupeLedgerEntryRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_dedupe_ledger")
          .selectAll()
          .$if(Boolean(options?.scope), (qb) => qb.where("scope", "=", options!.scope!))
          .$if(Boolean(options?.status), (qb) => qb.where("status", "=", options!.status!))
          .orderBy("last_seen_at", "desc")
          .orderBy("ledger_id", "desc")
          .limit(normalizeQueryLimit(options?.limit, 500)),
      );
      return rows.map(rowToDedupeLedgerEntry);
    },

    recordWakeDeliveryAttempt(
      input: RecordDurableWakeDeliveryAttemptInput,
    ): DurableWakeDeliveryAttempt {
      return recordWakeDeliveryAttemptRecord(input);
    },

    updateWakeDeliveryAttempt(
      input: UpdateDurableWakeDeliveryAttemptInput,
    ): DurableWakeDeliveryAttempt | undefined {
      return updateWakeDeliveryAttemptRecord(input);
    },

    getWakeDeliveryAttempt(deliveryAttemptId: string): DurableWakeDeliveryAttempt | undefined {
      return getWakeDeliveryAttemptRecord(deliveryAttemptId);
    },

    listWakeDeliveryAttempts(options?: {
      wakeId?: string;
      dedupeKey?: string;
      status?: DurableWakeDeliveryAttemptStatus;
      limit?: number;
    }): DurableWakeDeliveryAttempt[] {
      return listWakeDeliveryAttemptRecords(options);
    },

    listUnresolvedObligations(options?: {
      now?: number;
      limit?: number;
    }): DurableUnresolvedObligation[] {
      const now = options?.now ?? Date.now();
      const limit = normalizeQueryLimit(options?.limit, 500);
      const wakeRows = queryRows<DurableParentWakeRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_parent_wakes")
          .selectAll()
          .where("status", "in", ["pending", "delivered", "failed"])
          .orderBy("updated_at", "desc")
          .orderBy("wake_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `wake:${row.wake_id}`,
          kind: "pending_wake",
          runtime_run_id: row.source_run_id,
          step_id: null,
          wake_id: row.wake_id,
          uncertainty_fact_id: null,
          subject_ref: row.facts_ref ?? row.dedupe_key,
          reason: row.reason,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const uncertaintyRows = queryRows<DurableSideEffectUncertaintyFactRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_uncertainty_facts")
          .selectAll()
          .where("status", "=", "open")
          .orderBy("updated_at", "desc")
          .orderBy("fact_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `uncertainty:${row.fact_id}`,
          kind: "unresolved_uncertainty",
          runtime_run_id: row.source_run_id,
          step_id: row.step_id,
          wake_id: null,
          uncertainty_fact_id: row.fact_id,
          subject_ref: row.facts_ref ?? row.ref_id ?? row.event_id ?? row.dedupe_key,
          reason: row.kind,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const childRows = queryRows<DurableRuntimeLinkRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_links")
          .selectAll()
          .where("status", "in", ["pending", "running"])
          .orderBy("updated_at", "desc")
          .orderBy("child_runtime_run_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `child:${row.parent_runtime_run_id}:${row.parent_step_id}:${row.child_runtime_run_id}`,
          kind: "open_child",
          runtime_run_id: row.parent_runtime_run_id,
          step_id: row.parent_step_id,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.child_runtime_run_id,
          reason: row.link_type,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const expiredRunClaimRows = queryRows<DurableRuntimeRunRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_runs")
          .selectAll()
          .where("claimed_by", "is not", null)
          .where("claim_expires_at", "is not", null)
          .where("claim_expires_at", "<=", now)
          .where("status", "not in", ["succeeded", "failed", "cancelled", "lost"])
          .orderBy("updated_at", "desc")
          .orderBy("runtime_run_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `run-claim:${row.runtime_run_id}`,
          kind: "expired_run_claim",
          runtime_run_id: row.runtime_run_id,
          step_id: null,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.claimed_by,
          reason: row.recovery_state,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const expiredStepClaimRows = queryRows<DurableRuntimeStepRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_steps")
          .selectAll()
          .where("claimed_by", "is not", null)
          .where("claim_expires_at", "is not", null)
          .where("claim_expires_at", "<=", now)
          .where("status", "not in", ["succeeded", "failed", "cancelled", "lost", "skipped"])
          .orderBy("updated_at", "desc")
          .orderBy("runtime_run_id", "desc")
          .orderBy("step_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `step-claim:${row.runtime_run_id}:${row.step_id}`,
          kind: "expired_step_claim",
          runtime_run_id: row.runtime_run_id,
          step_id: row.step_id,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.claimed_by,
          reason: row.recovery_state,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      const resultMailboxRows = queryRows<DurableRuntimeStepRow>(
        db,
        durableDb
          .selectFrom("durable_runtime_steps")
          .selectAll()
          .where("step_type", "=", "result_mailbox")
          .where("status", "not in", ["succeeded", "failed", "cancelled", "lost", "skipped"])
          .orderBy("updated_at", "desc")
          .orderBy("runtime_run_id", "desc")
          .orderBy("step_id", "desc")
          .limit(limit),
      ).map(
        (row): DurableUnresolvedObligationRow => ({
          obligation_id: `result-mailbox:${row.runtime_run_id}:${row.step_id}`,
          kind: "pending_result_mailbox",
          runtime_run_id: row.runtime_run_id,
          step_id: row.step_id,
          wake_id: null,
          uncertainty_fact_id: null,
          subject_ref: row.idempotency_key,
          reason: row.step_type,
          status: row.status,
          created_at: row.created_at,
          updated_at: row.updated_at,
          metadata_json: row.metadata_json,
        }),
      );
      return [
        ...wakeRows,
        ...uncertaintyRows,
        ...childRows,
        ...expiredRunClaimRows,
        ...expiredStepClaimRows,
        ...resultMailboxRows,
      ]
        .sort((left, right) => {
          const updated = Number(right.updated_at) - Number(left.updated_at);
          return updated === 0 ? right.obligation_id.localeCompare(left.obligation_id) : updated;
        })
        .slice(0, limit)
        .map(rowToUnresolvedObligation);
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
        pendingWakes: count(
          db,
          durableDb
            .selectFrom("durable_runtime_parent_wakes")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("status", "in", ["pending", "delivered", "failed"]),
        ),
        unresolvedUncertaintyFacts: count(
          db,
          durableDb
            .selectFrom("durable_runtime_uncertainty_facts")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("status", "=", "open"),
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
