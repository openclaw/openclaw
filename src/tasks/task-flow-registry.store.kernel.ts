// Connection-bound task-flow row codecs and SQLite operations.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { ExecutionOwnerBindingResult } from "../audit/execution-owner-binding.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  deleteExecutionOwnerLifecycleMetadata,
} from "../audit/execution-owner-lifecycle-binding-store.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { applyFlowPatch, normalizeRestoredFlowRecord } from "./task-flow-registry.records.js";
import type {
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import { parseDeliveryContextJson, parseSqliteJsonValue } from "./task-registry.sqlite.shared.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryStoreDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;

type FlowRegistryRow = Selectable<FlowRunsTable> & {
  sync_mode: string | null;
  status: string;
  notify_policy: string;
};

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function resolveFlowSyncMode(row: {
  sync_mode: string | null;
  shape: string | null;
}): TaskFlowSyncMode {
  // Older single_task rows did not persist sync_mode; preserve their mirrored semantics.
  const syncMode = parseOptionalTaskFlowSyncMode(row.sync_mode);
  if (syncMode) {
    return syncMode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  return resolveFlowSyncMode(row);
}

function isFlowExecutionOwnerActive(row: {
  sync_mode: string | null;
  shape: string | null;
  status: string;
  cancel_requested_at: number | null;
  ended_at: number | null;
}): boolean {
  const syncMode = resolveFlowSyncMode(row);
  const status = parseTaskFlowStatus(row.status);
  if (row.cancel_requested_at !== null || row.ended_at !== null) {
    return false;
  }
  // Mirrored `blocked` is derived from a terminal task; managed `blocked`
  // remains live while its controller waits for the blocking task.
  return syncMode === "task_mirrored"
    ? status === "queued" || status === "running"
    : status === "queued" || status === "running" || status === "waiting" || status === "blocked";
}

function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeSqliteNumber(row.ended_at);
  const cancelRequestedAt = normalizeSqliteNumber(row.cancel_requested_at);
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const stateJson = parseSqliteJsonValue<JsonValue>(row.state_json);
  const waitJson = parseSqliteJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeSqliteNumber(row.revision) ?? 0,
    status: parseTaskFlowStatus(row.status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

type BoundTaskFlowRecord = Insertable<FlowRunsTable>;

export function bindTaskFlowRecord(record: TaskFlowRecord): BoundTaskFlowRecord {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    shape: null,
    owner_key: record.ownerKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeJson(record.stateJson),
    wait_json: serializeJson(record.waitJson),
    cancel_requested_at: record.cancelRequestedAt ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryStoreDatabase>(db);
}

const FLOW_RUN_SELECT_COLUMNS = [
  "flow_id",
  "sync_mode",
  "shape",
  "owner_key",
  "requester_origin_json",
  "controller_id",
  "revision",
  "status",
  "notify_policy",
  "goal",
  "current_step",
  "blocked_task_id",
  "blocked_summary",
  "state_json",
  "wait_json",
  "cancel_requested_at",
  "created_at",
  "updated_at",
  "ended_at",
] as const;

type TaskFlowRegistryQueries = {
  point?: ReturnType<typeof prepareSqliteQuerySync<string, FlowRegistryRow>>;
  owner?: ReturnType<typeof prepareSqliteQuerySync<string, FlowRegistryRow>>;
  viewOwner?: ReturnType<typeof prepareSqliteQuerySync<string, FlowRegistryRow>>;
  viewPoint?: ReturnType<typeof prepareSqliteQuerySync<string, FlowRegistryRow>>;
};
const taskFlowRegistryQueries = new WeakMap<DatabaseSync, TaskFlowRegistryQueries>();

function getTaskFlowRegistryQueries(db: DatabaseSync): TaskFlowRegistryQueries {
  let queries = taskFlowRegistryQueries.get(db);
  if (!queries) {
    queries = {};
    taskFlowRegistryQueries.set(db, queries);
  }
  return queries;
}

export function listTaskFlowRecordsForOwnerReadInDatabase(
  db: DatabaseSync,
  ownerKey: string,
): TaskFlowRecord[] {
  const queries = getTaskFlowRegistryQueries(db);
  const read = (queries.owner ??= prepareSqliteQuerySync<string, FlowRegistryRow>(db, (parameter) =>
    getFlowRegistryKysely(db)
      .selectFrom("flow_runs")
      .selectAll()
      .where(
        "owner_key",
        "=",
        parameter((value) => value),
      )
      .orderBy("created_at", "desc")
      .orderBy("flow_id", "asc"),
  ));
  return read(ownerKey).rows.map(rowToFlowRecord);
}

export function readTaskFlowRegistrySnapshot(db: DatabaseSync): TaskFlowRegistryStoreSnapshot {
  const query = getFlowRegistryKysely(db)
    .selectFrom("flow_runs")
    .select(FLOW_RUN_SELECT_COLUMNS)
    .orderBy("created_at", "asc")
    .orderBy("flow_id", "asc");
  const flows = new Map<string, TaskFlowRecord>();
  // Finish native reads before decoding so SQLite errors retain precedence.
  for (const row of executeSqliteQuerySync(db, query).rows) {
    flows.set(row.flow_id, rowToFlowRecord(row));
  }
  return { flows };
}

const FLOW_VIEW_SELECT_COLUMNS = FLOW_RUN_SELECT_COLUMNS.filter(
  (column) => column !== "state_json" && column !== "wait_json",
);

function flowViewQuery(db: DatabaseSync) {
  return getFlowRegistryKysely(db)
    .selectFrom("flow_runs")
    .select(FLOW_VIEW_SELECT_COLUMNS)
    .select((expression) => [
      expression.val(null).as("state_json"),
      expression.val(null).as("wait_json"),
    ]);
}

export function listTaskFlowViewRecordsForOwnerInDatabase(
  db: DatabaseSync,
  ownerKey: string,
): TaskFlowRecord[] {
  const queries = getTaskFlowRegistryQueries(db);
  const read = (queries.viewOwner ??= prepareSqliteQuerySync<string, FlowRegistryRow>(
    db,
    (parameter) =>
      flowViewQuery(db)
        .where(
          "owner_key",
          "=",
          parameter((value) => value),
        )
        .orderBy("created_at", "desc")
        .orderBy("flow_id", "asc"),
  ));
  return read(ownerKey).rows.map(rowToFlowRecord);
}

export function readTaskFlowViewRecordInDatabase(
  db: DatabaseSync,
  flowId: string,
): TaskFlowRecord | undefined {
  const queries = getTaskFlowRegistryQueries(db);
  const read = (queries.viewPoint ??= prepareSqliteQuerySync<string, FlowRegistryRow>(
    db,
    (parameter) =>
      flowViewQuery(db).where(
        "flow_id",
        "=",
        parameter((value) => value),
      ),
  ));
  const row = read(flowId).rows[0];
  return row ? rowToFlowRecord(row) : undefined;
}

export function upsertTaskFlowRowInDatabase(db: DatabaseSync, row: BoundTaskFlowRecord): void {
  executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db)
      .insertInto("flow_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("flow_id").doUpdateSet({
          sync_mode: (eb) => eb.ref("excluded.sync_mode"),
          owner_key: (eb) => eb.ref("excluded.owner_key"),
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          controller_id: (eb) => eb.ref("excluded.controller_id"),
          revision: (eb) => eb.ref("excluded.revision"),
          status: (eb) => eb.ref("excluded.status"),
          notify_policy: (eb) => eb.ref("excluded.notify_policy"),
          goal: (eb) => eb.ref("excluded.goal"),
          current_step: (eb) => eb.ref("excluded.current_step"),
          blocked_task_id: (eb) => eb.ref("excluded.blocked_task_id"),
          blocked_summary: (eb) => eb.ref("excluded.blocked_summary"),
          state_json: (eb) => eb.ref("excluded.state_json"),
          wait_json: (eb) => eb.ref("excluded.wait_json"),
          cancel_requested_at: (eb) => eb.ref("excluded.cancel_requested_at"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          updated_at: (eb) => eb.ref("excluded.updated_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
        }),
      ),
  );
}

export function readTaskFlowRecord(db: DatabaseSync, flowId: string): TaskFlowRecord | undefined {
  const queries = getTaskFlowRegistryQueries(db);
  const read = (queries.point ??= prepareSqliteQuerySync<string, FlowRegistryRow>(db, (parameter) =>
    getFlowRegistryKysely(db)
      .selectFrom("flow_runs")
      .selectAll()
      .where(
        "flow_id",
        "=",
        parameter((value) => value),
      ),
  ));
  const row = read(flowId).rows[0];
  return row ? rowToFlowRecord(row) : undefined;
}

/** The caller holds the SQLite write transaction across the revision check and update. */
export function updateTaskFlowRecordInDatabase(
  db: DatabaseSync,
  params: TaskFlowRegistryUpdate,
): TaskFlowRegistryUpdateResult {
  const stored = readTaskFlowRecord(db, params.flowId);
  if (!stored) {
    return { applied: false, reason: "not_found" };
  }
  const current = normalizeRestoredFlowRecord(stored);
  if (current.revision !== params.expectedRevision) {
    return { applied: false, reason: "revision_conflict", current };
  }
  let flow: TaskFlowRecord;
  try {
    flow = applyFlowPatch(current, params.patch);
  } catch (error) {
    return { applied: false, reason: "invalid_patch", error };
  }
  upsertTaskFlowRowInDatabase(db, bindTaskFlowRecord(flow));
  return { applied: true, previous: current, flow };
}

/** Revalidate the native flow lifecycle before recording its exact execution binding. */
export function bindTaskFlowExecutionInDatabase(
  db: DatabaseSync,
  flowId: string,
  binding: Parameters<typeof bindExecutionOwnerLifecycleMetadata>[0]["binding"],
): Exclude<ExecutionOwnerBindingResult, "disabled"> {
  const kysely = getFlowRegistryKysely(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("flow_runs")
      .select(["flow_id", "sync_mode", "shape", "status", "cancel_requested_at", "ended_at"])
      .where("flow_id", "=", flowId),
  );
  if (!current || !isFlowExecutionOwnerActive(current)) {
    return "missing";
  }
  return bindExecutionOwnerLifecycleMetadata({
    db,
    ownerKind: "flow",
    ownerId: current.flow_id,
    binding,
  });
}

/** The caller keeps the flow deletion and native metadata cleanup in one transaction. */
export function deleteTaskFlowRowInDatabase(db: DatabaseSync, flowId: string): void {
  executeSqliteQuerySync(
    db,
    getFlowRegistryKysely(db).deleteFrom("flow_runs").where("flow_id", "=", flowId),
  );
  deleteExecutionOwnerLifecycleMetadata({ db, ownerKind: "flow", ownerIds: [flowId] });
}
