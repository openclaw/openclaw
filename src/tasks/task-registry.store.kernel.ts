// Connection-bound task row codecs and SQLite operations; callers own database lifetime.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { ExecutionOwnerBindingResult } from "../audit/execution-owner-binding.js";
import {
  bindExecutionOwnerLifecycleMetadata,
  deleteExecutionOwnerLifecycleMetadata,
} from "../audit/execution-owner-lifecycle-binding-store.js";
import { executeWithCachedStatement } from "../infra/kysely-sync-cache-state.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  prepareSqliteQuerySync,
} from "../infra/kysely-sync.js";
import { assertSqliteTableIntegrity } from "../infra/sqlite-integrity.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists, tableHasColumns } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { normalizeTaskTimestamps } from "./task-registry-records.js";
import { parseDeliveryContextJson, parseSqliteJsonValue } from "./task-registry.sqlite.shared.js";
import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import {
  parseOptionalTaskTerminalOutcome,
  parseTaskDeliveryStatus,
  parseTaskNotifyPolicy,
  parseTaskRuntime,
  parseTaskScopeKind,
  parseTaskStatus,
  type TaskDeliveryState,
  type JsonValue,
  type TaskRecord,
  type TaskRuntime,
} from "./task-registry.types.js";

type TaskRunsTable = OpenClawStateKyselyDatabase["task_runs"];
type TaskDeliveryStateTable = OpenClawStateKyselyDatabase["task_delivery_state"];
type TaskRegistryStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "task_delivery_state" | "task_runs"
>;

type TaskRegistryRow = Selectable<TaskRunsTable> & {
  runtime: string;
  scope_kind: string;
  status: string;
  delivery_status: string;
  notify_policy: string;
  terminal_outcome: string | null;
};

type TaskDeliveryStateRow = Selectable<TaskDeliveryStateTable>;

export type TaskRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

const TASK_RUN_SELECT_COLUMNS = [
  "task_id",
  "runtime",
  "task_kind",
  "source_id",
  "requester_session_key",
  "owner_key",
  "scope_kind",
  "child_session_key",
  "parent_flow_id",
  "parent_task_id",
  "agent_id",
  "requester_agent_id",
  "run_id",
  "label",
  "task",
  "status",
  "delivery_status",
  "notify_policy",
  "created_at",
  "started_at",
  "ended_at",
  "last_event_at",
  "cleanup_after",
  "tool_use_count",
  "last_tool_name",
  "error",
  "progress_summary",
  "terminal_summary",
  "terminal_outcome",
  "detail_json",
] as const;

const TASK_DELIVERY_STATE_SELECT_COLUMNS = [
  "task_id",
  "requester_origin_json",
  "last_notified_event_at",
] as const;

export type TaskRegistryReadOnlyLoadResult = {
  state: "ready" | "migration-required";
  snapshot: TaskRegistryStoreSnapshot;
};

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : (JSON.stringify(value) ?? null);
}

function rowToTaskRecord(row: TaskRegistryRow): TaskRecord {
  const startedAt = normalizeSqliteNumber(row.started_at);
  const endedAt = normalizeSqliteNumber(row.ended_at);
  const lastEventAt = normalizeSqliteNumber(row.last_event_at);
  const cleanupAfter = normalizeSqliteNumber(row.cleanup_after);
  const toolUseCount = normalizeSqliteNumber(row.tool_use_count);
  const scopeKind = parseTaskScopeKind(row.scope_kind);
  const terminalOutcome = parseOptionalTaskTerminalOutcome(row.terminal_outcome);
  const detail = parseSqliteJsonValue<JsonValue>(row.detail_json);
  // System tasks intentionally have no requester session; ownerKey is the lookup anchor.
  const requesterSessionKey =
    scopeKind === "system" ? "" : row.requester_session_key?.trim() || row.owner_key;
  return normalizeTaskTimestamps({
    taskId: row.task_id,
    runtime: parseTaskRuntime(row.runtime),
    ...(row.task_kind ? { taskKind: row.task_kind } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    requesterSessionKey,
    ownerKey: row.owner_key,
    scopeKind,
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.parent_flow_id ? { parentFlowId: row.parent_flow_id } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.requester_agent_id ? { requesterAgentId: row.requester_agent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    task: row.task,
    status: parseTaskStatus(row.status),
    deliveryStatus: parseTaskDeliveryStatus(row.delivery_status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    ...(startedAt != null ? { startedAt } : {}),
    ...(endedAt != null ? { endedAt } : {}),
    ...(lastEventAt != null ? { lastEventAt } : {}),
    ...(cleanupAfter != null ? { cleanupAfter } : {}),
    ...(toolUseCount != null ? { toolUseCount } : {}),
    ...(row.last_tool_name ? { lastToolName: row.last_tool_name } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
    ...(row.terminal_summary !== null ? { terminalSummary: row.terminal_summary } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    ...(detail !== undefined ? { detail } : {}),
  });
}

function rowToTaskDeliveryState(row: TaskDeliveryStateRow): TaskDeliveryState {
  const requesterOrigin = parseDeliveryContextJson(row.requester_origin_json);
  const lastNotifiedEventAt = normalizeSqliteNumber(row.last_notified_event_at);
  return {
    taskId: row.task_id,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(lastNotifiedEventAt != null ? { lastNotifiedEventAt } : {}),
  };
}

type BoundTaskRecord = Insertable<TaskRunsTable>;

/** Canonically serializes a task before an outer transaction acquires the write lock. */
export function bindTaskRecord(record: TaskRecord): BoundTaskRecord {
  const normalized = normalizeTaskTimestamps(record);
  return {
    task_id: normalized.taskId,
    runtime: normalized.runtime,
    task_kind: normalized.taskKind ?? null,
    source_id: normalized.sourceId ?? null,
    requester_session_key: normalized.scopeKind === "system" ? "" : normalized.requesterSessionKey,
    owner_key: normalized.ownerKey,
    scope_kind: normalized.scopeKind,
    child_session_key: normalized.childSessionKey ?? null,
    parent_flow_id: normalized.parentFlowId ?? null,
    parent_task_id: normalized.parentTaskId ?? null,
    agent_id: normalized.agentId ?? null,
    requester_agent_id: normalized.requesterAgentId ?? null,
    run_id: normalized.runId ?? null,
    label: normalized.label ?? null,
    task: normalized.task,
    status: normalized.status,
    delivery_status: normalized.deliveryStatus,
    notify_policy: normalized.notifyPolicy,
    created_at: normalized.createdAt,
    started_at: normalized.startedAt ?? null,
    ended_at: normalized.endedAt ?? null,
    last_event_at: normalized.lastEventAt ?? null,
    cleanup_after: normalized.cleanupAfter ?? null,
    tool_use_count: normalized.toolUseCount ?? null,
    last_tool_name: normalized.lastToolName ?? null,
    error: normalized.error ?? null,
    progress_summary: normalized.progressSummary ?? null,
    terminal_summary: normalized.terminalSummary ?? null,
    terminal_outcome: normalized.terminalOutcome ?? null,
    detail_json: serializeJson(normalized.detail),
  };
}

function bindTaskDeliveryState(state: TaskDeliveryState): Insertable<TaskDeliveryStateTable> {
  return {
    task_id: state.taskId,
    requester_origin_json: serializeJson(state.requesterOrigin),
    last_notified_event_at: state.lastNotifiedEventAt ?? null,
  };
}

function getTaskRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TaskRegistryStoreDatabase>(db);
}

type TaskRegistryQuery<Params> = ReturnType<typeof prepareSqliteQuerySync<Params, TaskRegistryRow>>;
type TaskRegistryQueries = {
  point?: TaskRegistryQuery<string>;
  runtime?: TaskRegistryQuery<TaskRuntime>;
  runtimeSource?: TaskRegistryQuery<{ runtime: TaskRuntime; sourceId: string }>;
};
const taskRegistryQueries = new WeakMap<DatabaseSync, TaskRegistryQueries>();

function getTaskRegistryQueries(db: DatabaseSync): TaskRegistryQueries {
  let queries = taskRegistryQueries.get(db);
  if (!queries) {
    queries = {};
    taskRegistryQueries.set(db, queries);
  }
  return queries;
}

function selectTaskRows(db: DatabaseSync): TaskRegistryRow[] {
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_runs")
    .select(TASK_RUN_SELECT_COLUMNS)
    .orderBy("created_at", "asc")
    .orderBy("task_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

function selectTaskRowsByOwnerKey(db: DatabaseSync, ownerKey: string): TaskRegistryRow[] {
  const selectColumns = TASK_RUN_SELECT_COLUMNS.join(", ");
  // This lookup gates duplicate media tasks. A table scan is intentional so a
  // stale secondary index cannot hide an existing task between integrity checks.
  return executeWithCachedStatement(
    db,
    `SELECT ${selectColumns}
       FROM task_runs NOT INDEXED
       WHERE owner_key = ?
       ORDER BY created_at ASC, task_id ASC`,
    [ownerKey],
    // SAFETY: The admitted handle has the canonical columns projected above.
    (statement) => statement.all(ownerKey) as TaskRegistryRow[],
  );
}

function selectTaskRowsByRuntimeSourceId(
  db: DatabaseSync,
  runtime: TaskRuntime,
  sourceId?: string,
): TaskRegistryRow[] {
  const queries = getTaskRegistryQueries(db);
  if (sourceId === undefined) {
    const read = (queries.runtime ??= prepareSqliteQuerySync<TaskRuntime, TaskRegistryRow>(
      db,
      (parameter) =>
        getTaskRegistryKysely(db)
          .selectFrom("task_runs")
          .select(TASK_RUN_SELECT_COLUMNS)
          .where(
            "runtime",
            "=",
            parameter((value) => value),
          )
          .orderBy("created_at", "asc")
          .orderBy("task_id", "asc"),
    ));
    return read(runtime).rows;
  }
  const read = (queries.runtimeSource ??= prepareSqliteQuerySync<
    { runtime: TaskRuntime; sourceId: string },
    TaskRegistryRow
  >(db, (parameter) =>
    getTaskRegistryKysely(db)
      .selectFrom("task_runs")
      .select(TASK_RUN_SELECT_COLUMNS)
      .where(
        "runtime",
        "=",
        parameter((params) => params.runtime),
      )
      .where(
        "source_id",
        "=",
        parameter((params) => params.sourceId),
      )
      .orderBy("created_at", "asc")
      .orderBy("task_id", "asc"),
  ));
  return read({ runtime, sourceId }).rows;
}

/** Reads task records from the caller's shared-state transaction. */
export function listTaskRecordsByRuntimeSourceIdInDatabase(
  db: DatabaseSync,
  runtime: TaskRuntime,
  sourceId?: string,
): TaskRecord[] {
  return selectTaskRowsByRuntimeSourceId(db, runtime, sourceId).map(rowToTaskRecord);
}

export function readTaskRecord(db: DatabaseSync, taskId: string): TaskRecord | undefined {
  const queries = getTaskRegistryQueries(db);
  const read = (queries.point ??= prepareSqliteQuerySync<string, TaskRegistryRow>(db, (parameter) =>
    getTaskRegistryKysely(db)
      .selectFrom("task_runs")
      .select(TASK_RUN_SELECT_COLUMNS)
      .where(
        "task_id",
        "=",
        parameter((value) => value),
      ),
  ));
  const row = read(taskId).rows[0];
  return row ? rowToTaskRecord(row) : undefined;
}

function selectTaskDeliveryStateRows(db: DatabaseSync): TaskDeliveryStateRow[] {
  const query = getTaskRegistryKysely(db)
    .selectFrom("task_delivery_state")
    .select(TASK_DELIVERY_STATE_SELECT_COLUMNS)
    .orderBy("task_id", "asc");
  return executeSqliteQuerySync(db, query).rows;
}

/** Upserts a prebound task on the exact supplied shared-state handle. */
export function upsertTaskRunRowInDatabase(
  database: Pick<TaskRegistryDatabase, "db">,
  row: BoundTaskRecord,
): void {
  const { db } = database;
  const updates = { ...row, task_id: undefined };
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_runs")
      .values(row)
      .onConflict((conflict) => conflict.column("task_id").doUpdateSet(updates)),
  );
}

function replaceTaskDeliveryStateRow(
  db: DatabaseSync,
  row: Insertable<TaskDeliveryStateTable>,
): void {
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_delivery_state")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("task_id").doUpdateSet({
          requester_origin_json: (eb) => eb.ref("excluded.requester_origin_json"),
          last_notified_event_at: (eb) => eb.ref("excluded.last_notified_event_at"),
        }),
      ),
  );
}

export function deleteTaskRowsWithDeliveryState(db: DatabaseSync, taskId: string): void {
  const kysely = getTaskRegistryKysely(db);
  executeSqliteQuerySync(
    db,
    kysely.deleteFrom("task_delivery_state").where("task_id", "=", taskId),
  );
  executeSqliteQuerySync(db, kysely.deleteFrom("task_runs").where("task_id", "=", taskId));
  deleteExecutionOwnerLifecycleMetadata({ db, ownerKind: "task", ownerIds: [taskId] });
}

export function readTaskRegistrySnapshot({
  db,
  path,
}: TaskRegistryDatabase): TaskRegistryStoreSnapshot {
  return runSqliteDeferredTransactionSync(db, () => {
    assertSqliteTableIntegrity(db, path, "task_runs");
    assertSqliteTableIntegrity(db, path, "task_delivery_state");
    const taskRows = selectTaskRows(db);
    const deliveryRows = selectTaskDeliveryStateRows(db);
    return {
      tasks: new Map(taskRows.map((row) => [row.task_id, rowToTaskRecord(row)])),
      deliveryStates: new Map(
        deliveryRows.map((row) => [row.task_id, rowToTaskDeliveryState(row)]),
      ),
    };
  });
}

/** Inspect only the supplied existing connection; never create or repair its schema. */
export function readTaskRegistrySnapshotIfReady(
  database: TaskRegistryDatabase,
): TaskRegistryReadOnlyLoadResult {
  const { db } = database;
  const hasReadableSchema =
    tableExists(db, "task_runs") &&
    tableExists(db, "task_delivery_state") &&
    tableHasColumns(db, "task_runs", TASK_RUN_SELECT_COLUMNS) &&
    tableHasColumns(db, "task_delivery_state", TASK_DELIVERY_STATE_SELECT_COLUMNS);
  return hasReadableSchema
    ? { state: "ready", snapshot: readTaskRegistrySnapshot(database) }
    : {
        state: "migration-required",
        snapshot: { tasks: new Map(), deliveryStates: new Map() },
      };
}

export function listTaskRecordsByOwnerKeyInDatabase(
  db: DatabaseSync,
  ownerKey: string,
): TaskRecord[] {
  return selectTaskRowsByOwnerKey(db, ownerKey).map(rowToTaskRecord);
}

/** Revalidate and bind the exact task row inside its caller's transaction. */
export function bindTaskRunExecutionInDatabase(
  db: DatabaseSync,
  taskId: string,
  binding: Parameters<typeof bindExecutionOwnerLifecycleMetadata>[0]["binding"],
): Exclude<ExecutionOwnerBindingResult, "disabled"> {
  const kysely = getTaskRegistryKysely(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("task_runs")
      .select(["task_id", "status", "ended_at"])
      .where("task_id", "=", taskId),
  );
  const status = current ? parseTaskStatus(current.status) : undefined;
  if (!current || (status !== "queued" && status !== "running") || current.ended_at !== null) {
    return "missing";
  }
  return bindExecutionOwnerLifecycleMetadata({
    db,
    ownerKind: "task",
    ownerId: current.task_id,
    binding,
  });
}

/** The caller's transaction covers both the task and delivery-state mutation. */
export function upsertTaskWithDeliveryStateInDatabase(
  database: Pick<TaskRegistryDatabase, "db">,
  params: { task: TaskRecord; deliveryState?: TaskDeliveryState },
): void {
  const { db } = database;
  upsertTaskRunRowInDatabase(database, bindTaskRecord(params.task));
  if (params.deliveryState) {
    replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(params.deliveryState));
  } else {
    executeSqliteQuerySync(
      db,
      getTaskRegistryKysely(db)
        .deleteFrom("task_delivery_state")
        .where("task_id", "=", params.task.taskId),
    );
  }
}

export function upsertTaskDeliveryStateInDatabase(
  db: DatabaseSync,
  state: TaskDeliveryState,
): void {
  replaceTaskDeliveryStateRow(db, bindTaskDeliveryState(state));
}
