import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { resolveLegacyPluginStateSqlitePath } from "../plugin-state/plugin-state-store.paths.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveLegacyTaskFlowRegistrySqlitePath } from "../tasks/task-flow-registry.paths.js";
import type { TaskFlowRecord, TaskFlowSyncMode } from "../tasks/task-flow-registry.types.js";
import { resolveLegacyTaskRegistrySqlitePath } from "../tasks/task-registry.paths.js";
import type { TaskDeliveryState, TaskRecord } from "../tasks/task-registry.types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

const SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

type PluginStateEntriesTable = OpenClawStateKyselyDatabase["plugin_state_entries"];
type PluginStateRow = Selectable<PluginStateEntriesTable>;
type PluginStateDatabase = Pick<OpenClawStateKyselyDatabase, "plugin_state_entries">;

type TaskRunsTable = OpenClawStateKyselyDatabase["task_runs"];
type TaskDeliveryStateTable = OpenClawStateKyselyDatabase["task_delivery_state"];
type TaskRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "task_delivery_state" | "task_runs">;
type TaskRegistryRow = Selectable<TaskRunsTable> & {
  runtime: TaskRecord["runtime"];
  scope_kind: TaskRecord["scopeKind"];
  status: TaskRecord["status"];
  delivery_status: TaskRecord["deliveryStatus"];
  notify_policy: TaskRecord["notifyPolicy"];
  terminal_outcome: TaskRecord["terminalOutcome"] | null;
};
type TaskDeliveryStateRow = Selectable<TaskDeliveryStateTable>;

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;
type FlowRegistryRow = Selectable<FlowRunsTable> & {
  sync_mode: TaskFlowSyncMode | null;
  status: TaskFlowRecord["status"];
  notify_policy: TaskFlowRecord["notifyPolicy"];
};

type TableInfoRow = {
  name: string;
};

export type LegacyPluginStateSidecarImportResult = {
  sourcePath: string;
  importedEntries: number;
  removedSource: boolean;
};

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Legacy JSON columns are typed by the receiving field.
function parseJsonValue<T>(raw: string | null): T | undefined {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function getPluginStateKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<PluginStateDatabase>(db);
}

function getTaskRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<TaskRegistryDatabase>(db);
}

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryDatabase>(db);
}

function removeSqliteSidecars(pathname: string): boolean {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    rmSync(`${pathname}${suffix}`, { force: true });
  }
  return !existsSync(pathname);
}

function selectPluginStateRows(db: DatabaseSync): PluginStateRow[] {
  return executeSqliteQuerySync<PluginStateRow>(
    db,
    getPluginStateKysely(db)
      .selectFrom("plugin_state_entries")
      .select(["plugin_id", "namespace", "entry_key", "value_json", "created_at", "expires_at"])
      .orderBy("plugin_id", "asc")
      .orderBy("namespace", "asc")
      .orderBy("entry_key", "asc"),
  ).rows;
}

function upsertPluginStateRow(db: DatabaseSync, row: Insertable<PluginStateEntriesTable>): void {
  executeSqliteQuerySync(
    db,
    getPluginStateKysely(db)
      .insertInto("plugin_state_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["plugin_id", "namespace", "entry_key"]).doUpdateSet({
          value_json: (eb) => eb.ref("excluded.value_json"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          expires_at: (eb) => eb.ref("excluded.expires_at"),
        }),
      ),
  );
}

export function legacyPluginStateSidecarExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveLegacyPluginStateSqlitePath(env));
}

export function importLegacyPluginStateSidecarToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): LegacyPluginStateSidecarImportResult {
  const sourcePath = resolveLegacyPluginStateSqlitePath(env);
  if (!existsSync(sourcePath)) {
    return {
      sourcePath,
      importedEntries: 0,
      removedSource: false,
    };
  }

  const { DatabaseSync } = requireNodeSqlite();
  const legacyDb = new DatabaseSync(sourcePath);
  let rows: PluginStateRow[];
  try {
    rows = selectPluginStateRows(legacyDb);
  } finally {
    legacyDb.close();
  }

  runOpenClawStateWriteTransaction(
    (database) => {
      for (const row of rows) {
        upsertPluginStateRow(database.db, {
          ...row,
          created_at: normalizeNumber(row.created_at) ?? 0,
          expires_at: normalizeNumber(row.expires_at) ?? null,
        });
      }
    },
    { env },
  );

  return {
    sourcePath,
    importedEntries: rows.length,
    removedSource: removeSqliteSidecars(sourcePath),
  };
}

function hasLegacyColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[];
  return rows.some((row) => row.name === columnName);
}

function migrateLegacyTaskOwnerColumns(db: DatabaseSync) {
  if (!hasLegacyColumn(db, "task_runs", "owner_key")) {
    db.exec(`ALTER TABLE task_runs ADD COLUMN owner_key TEXT;`);
  }
  if (!hasLegacyColumn(db, "task_runs", "requester_session_key")) {
    db.exec(`ALTER TABLE task_runs ADD COLUMN requester_session_key TEXT;`);
  }
  if (!hasLegacyColumn(db, "task_runs", "scope_kind")) {
    db.exec(`ALTER TABLE task_runs ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'session';`);
  }
  db.exec(`
    UPDATE task_runs
    SET owner_key = requester_session_key
    WHERE owner_key IS NULL
  `);
  db.exec(`
    UPDATE task_runs
    SET owner_key = CASE
      WHEN trim(COALESCE(owner_key, '')) <> '' THEN trim(owner_key)
      ELSE 'system:' || runtime || ':' || COALESCE(NULLIF(source_id, ''), task_id)
    END
  `);
  db.exec(`
    UPDATE task_runs
    SET scope_kind = CASE
      WHEN scope_kind = 'system' THEN 'system'
      WHEN owner_key LIKE 'system:%' THEN 'system'
      ELSE 'session'
    END
  `);
  db.exec(`
    UPDATE task_runs
    SET requester_session_key = CASE
      WHEN scope_kind = 'system' THEN ''
      WHEN trim(COALESCE(requester_session_key, '')) <> '' THEN trim(requester_session_key)
      ELSE owner_key
    END
  `);
}

function ensureLegacyTaskRegistrySchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_runs (
      task_id TEXT NOT NULL PRIMARY KEY,
      runtime TEXT NOT NULL,
      task_kind TEXT,
      source_id TEXT,
      requester_session_key TEXT,
      owner_key TEXT NOT NULL,
      scope_kind TEXT NOT NULL,
      child_session_key TEXT,
      parent_flow_id TEXT,
      parent_task_id TEXT,
      agent_id TEXT,
      run_id TEXT,
      label TEXT,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      last_event_at INTEGER,
      cleanup_after INTEGER,
      error TEXT,
      progress_summary TEXT,
      terminal_summary TEXT,
      terminal_outcome TEXT
    );
  `);
  migrateLegacyTaskOwnerColumns(db);
  for (const column of ["task_kind", "parent_flow_id"]) {
    if (!hasLegacyColumn(db, "task_runs", column)) {
      db.exec(`ALTER TABLE task_runs ADD COLUMN ${column} TEXT;`);
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_delivery_state (
      task_id TEXT NOT NULL PRIMARY KEY,
      requester_origin_json TEXT,
      last_notified_event_at INTEGER
    );
  `);
}

function rowToTaskRecord(row: TaskRegistryRow): TaskRecord {
  const startedAt = normalizeNumber(row.started_at);
  const endedAt = normalizeNumber(row.ended_at);
  const lastEventAt = normalizeNumber(row.last_event_at);
  const cleanupAfter = normalizeNumber(row.cleanup_after);
  const requesterSessionKey =
    row.scope_kind === "system" ? "" : row.requester_session_key?.trim() || row.owner_key;
  return {
    taskId: row.task_id,
    runtime: row.runtime,
    ...(row.task_kind ? { taskKind: row.task_kind } : {}),
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    requesterSessionKey,
    ownerKey: row.owner_key,
    scopeKind: row.scope_kind,
    ...(row.child_session_key ? { childSessionKey: row.child_session_key } : {}),
    ...(row.parent_flow_id ? { parentFlowId: row.parent_flow_id } : {}),
    ...(row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.label ? { label: row.label } : {}),
    task: row.task,
    status: row.status,
    deliveryStatus: row.delivery_status,
    notifyPolicy: row.notify_policy,
    createdAt: normalizeNumber(row.created_at) ?? 0,
    ...(startedAt != null ? { startedAt } : {}),
    ...(endedAt != null ? { endedAt } : {}),
    ...(lastEventAt != null ? { lastEventAt } : {}),
    ...(cleanupAfter != null ? { cleanupAfter } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.progress_summary ? { progressSummary: row.progress_summary } : {}),
    ...(row.terminal_summary ? { terminalSummary: row.terminal_summary } : {}),
    ...(row.terminal_outcome ? { terminalOutcome: row.terminal_outcome } : {}),
  };
}

function rowToTaskDeliveryState(row: TaskDeliveryStateRow): TaskDeliveryState {
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const lastNotifiedEventAt = normalizeNumber(row.last_notified_event_at);
  return {
    taskId: row.task_id,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(lastNotifiedEventAt != null ? { lastNotifiedEventAt } : {}),
  };
}

function bindTaskRecord(record: TaskRecord): Insertable<TaskRunsTable> {
  return {
    task_id: record.taskId,
    runtime: record.runtime,
    task_kind: record.taskKind ?? null,
    source_id: record.sourceId ?? null,
    requester_session_key: record.scopeKind === "system" ? "" : record.requesterSessionKey,
    owner_key: record.ownerKey,
    scope_kind: record.scopeKind,
    child_session_key: record.childSessionKey ?? null,
    parent_flow_id: record.parentFlowId ?? null,
    parent_task_id: record.parentTaskId ?? null,
    agent_id: record.agentId ?? null,
    run_id: record.runId ?? null,
    label: record.label ?? null,
    task: record.task,
    status: record.status,
    delivery_status: record.deliveryStatus,
    notify_policy: record.notifyPolicy,
    created_at: record.createdAt,
    started_at: record.startedAt ?? null,
    ended_at: record.endedAt ?? null,
    last_event_at: record.lastEventAt ?? null,
    cleanup_after: record.cleanupAfter ?? null,
    error: record.error ?? null,
    progress_summary: record.progressSummary ?? null,
    terminal_summary: record.terminalSummary ?? null,
    terminal_outcome: record.terminalOutcome ?? null,
  };
}

function bindTaskDeliveryState(state: TaskDeliveryState): Insertable<TaskDeliveryStateTable> {
  return {
    task_id: state.taskId,
    requester_origin_json: serializeJson(state.requesterOrigin),
    last_notified_event_at: state.lastNotifiedEventAt ?? null,
  };
}

function selectTaskRows(db: DatabaseSync): TaskRegistryRow[] {
  return executeSqliteQuerySync<TaskRegistryRow>(
    db,
    getTaskRegistryKysely(db)
      .selectFrom("task_runs")
      .select([
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
        "error",
        "progress_summary",
        "terminal_summary",
        "terminal_outcome",
      ])
      .orderBy("created_at", "asc")
      .orderBy("task_id", "asc"),
  ).rows;
}

function selectTaskDeliveryStateRows(db: DatabaseSync): TaskDeliveryStateRow[] {
  return executeSqliteQuerySync<TaskDeliveryStateRow>(
    db,
    getTaskRegistryKysely(db)
      .selectFrom("task_delivery_state")
      .select(["task_id", "requester_origin_json", "last_notified_event_at"])
      .orderBy("task_id", "asc"),
  ).rows;
}

function upsertTaskRow(db: DatabaseSync, row: Insertable<TaskRunsTable>): void {
  executeSqliteQuerySync(
    db,
    getTaskRegistryKysely(db)
      .insertInto("task_runs")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("task_id").doUpdateSet({
          runtime: (eb) => eb.ref("excluded.runtime"),
          task_kind: (eb) => eb.ref("excluded.task_kind"),
          source_id: (eb) => eb.ref("excluded.source_id"),
          requester_session_key: (eb) => eb.ref("excluded.requester_session_key"),
          owner_key: (eb) => eb.ref("excluded.owner_key"),
          scope_kind: (eb) => eb.ref("excluded.scope_kind"),
          child_session_key: (eb) => eb.ref("excluded.child_session_key"),
          parent_flow_id: (eb) => eb.ref("excluded.parent_flow_id"),
          parent_task_id: (eb) => eb.ref("excluded.parent_task_id"),
          agent_id: (eb) => eb.ref("excluded.agent_id"),
          run_id: (eb) => eb.ref("excluded.run_id"),
          label: (eb) => eb.ref("excluded.label"),
          task: (eb) => eb.ref("excluded.task"),
          status: (eb) => eb.ref("excluded.status"),
          delivery_status: (eb) => eb.ref("excluded.delivery_status"),
          notify_policy: (eb) => eb.ref("excluded.notify_policy"),
          created_at: (eb) => eb.ref("excluded.created_at"),
          started_at: (eb) => eb.ref("excluded.started_at"),
          ended_at: (eb) => eb.ref("excluded.ended_at"),
          last_event_at: (eb) => eb.ref("excluded.last_event_at"),
          cleanup_after: (eb) => eb.ref("excluded.cleanup_after"),
          error: (eb) => eb.ref("excluded.error"),
          progress_summary: (eb) => eb.ref("excluded.progress_summary"),
          terminal_summary: (eb) => eb.ref("excluded.terminal_summary"),
          terminal_outcome: (eb) => eb.ref("excluded.terminal_outcome"),
        }),
      ),
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

export function legacyTaskRegistrySidecarExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveLegacyTaskRegistrySqlitePath(env));
}

export function importLegacyTaskRegistrySidecarToSqlite(env: NodeJS.ProcessEnv = process.env): {
  importedTasks: number;
  importedDeliveryStates: number;
  removedSource: boolean;
  sourcePath: string;
} {
  const sourcePath = resolveLegacyTaskRegistrySqlitePath(env);
  if (!existsSync(sourcePath)) {
    return {
      importedTasks: 0,
      importedDeliveryStates: 0,
      removedSource: false,
      sourcePath,
    };
  }

  const { DatabaseSync } = requireNodeSqlite();
  const legacyDb = new DatabaseSync(sourcePath);
  let tasks: TaskRecord[];
  let deliveryStates: TaskDeliveryState[];
  try {
    ensureLegacyTaskRegistrySchema(legacyDb);
    tasks = selectTaskRows(legacyDb).map(rowToTaskRecord);
    deliveryStates = selectTaskDeliveryStateRows(legacyDb).map(rowToTaskDeliveryState);
  } finally {
    legacyDb.close();
  }
  runOpenClawStateWriteTransaction(
    (database) => {
      for (const task of tasks) {
        upsertTaskRow(database.db, bindTaskRecord(task));
      }
      for (const deliveryState of deliveryStates) {
        replaceTaskDeliveryStateRow(database.db, bindTaskDeliveryState(deliveryState));
      }
    },
    { env },
  );
  return {
    importedTasks: tasks.length,
    importedDeliveryStates: deliveryStates.length,
    removedSource: removeSqliteSidecars(sourcePath),
    sourcePath,
  };
}

export function removeLegacyTaskRegistrySidecar(env: NodeJS.ProcessEnv = process.env): {
  removedSource: boolean;
  sourcePath: string;
} {
  const sourcePath = resolveLegacyTaskRegistrySqlitePath(env);
  return {
    removedSource: removeSqliteSidecars(sourcePath),
    sourcePath,
  };
}

function ensureLegacyTaskFlowRegistrySchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_runs (
      flow_id TEXT NOT NULL PRIMARY KEY,
      shape TEXT,
      sync_mode TEXT NOT NULL DEFAULT 'managed',
      owner_key TEXT NOT NULL,
      requester_origin_json TEXT,
      controller_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      goal TEXT NOT NULL,
      current_step TEXT,
      blocked_task_id TEXT,
      blocked_summary TEXT,
      state_json TEXT,
      wait_json TEXT,
      cancel_requested_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  if (
    !hasLegacyColumn(db, "flow_runs", "owner_key") &&
    hasLegacyColumn(db, "flow_runs", "owner_session_key")
  ) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN owner_key TEXT;`);
    db.exec(`
      UPDATE flow_runs
      SET owner_key = owner_session_key
      WHERE owner_key IS NULL
    `);
  }
  const optionalColumns = [
    ["shape", "TEXT"],
    ["sync_mode", "TEXT"],
    ["controller_id", "TEXT"],
    ["revision", "INTEGER"],
    ["blocked_task_id", "TEXT"],
    ["blocked_summary", "TEXT"],
    ["state_json", "TEXT"],
    ["wait_json", "TEXT"],
    ["cancel_requested_at", "INTEGER"],
  ] as const;
  for (const [column, type] of optionalColumns) {
    if (!hasLegacyColumn(db, "flow_runs", column)) {
      db.exec(`ALTER TABLE flow_runs ADD COLUMN ${column} ${type};`);
    }
  }
  db.exec(`
    UPDATE flow_runs
    SET sync_mode = CASE
      WHEN shape = 'single_task' THEN 'task_mirrored'
      ELSE COALESCE(sync_mode, 'managed')
    END
    WHERE sync_mode IS NULL
  `);
  db.exec(`
    UPDATE flow_runs
    SET controller_id = 'core/legacy-restored'
    WHERE sync_mode = 'managed'
      AND (controller_id IS NULL OR trim(controller_id) = '')
  `);
  db.exec(`
    UPDATE flow_runs
    SET revision = 0
    WHERE revision IS NULL
  `);
}

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  if (row.sync_mode === "task_mirrored" || row.sync_mode === "managed") {
    return row.sync_mode;
  }
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeNumber(row.ended_at);
  const cancelRequestedAt = normalizeNumber(row.cancel_requested_at);
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const stateJson = parseJsonValue<TaskFlowRecord["stateJson"]>(row.state_json);
  const waitJson = parseJsonValue<TaskFlowRecord["waitJson"]>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeNumber(row.revision) ?? 0,
    status: row.status,
    notifyPolicy: row.notify_policy,
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    updatedAt: normalizeNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

function bindFlowRecord(record: TaskFlowRecord): Insertable<FlowRunsTable> {
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

function selectFlowRows(db: DatabaseSync): FlowRegistryRow[] {
  return executeSqliteQuerySync<FlowRegistryRow>(
    db,
    getFlowRegistryKysely(db)
      .selectFrom("flow_runs")
      .select([
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
      ])
      .orderBy("created_at", "asc")
      .orderBy("flow_id", "asc"),
  ).rows;
}

function upsertFlowRow(db: DatabaseSync, row: Insertable<FlowRunsTable>): void {
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

export function legacyTaskFlowRegistrySidecarExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveLegacyTaskFlowRegistrySqlitePath(env));
}

export function importLegacyTaskFlowRegistrySidecarToSqlite(env: NodeJS.ProcessEnv = process.env): {
  importedFlows: number;
  removedSource: boolean;
  sourcePath: string;
} {
  const sourcePath = resolveLegacyTaskFlowRegistrySqlitePath(env);
  if (!existsSync(sourcePath)) {
    return {
      importedFlows: 0,
      removedSource: false,
      sourcePath,
    };
  }

  const { DatabaseSync } = requireNodeSqlite();
  const legacyDb = new DatabaseSync(sourcePath);
  let flows: TaskFlowRecord[];
  try {
    ensureLegacyTaskFlowRegistrySchema(legacyDb);
    flows = selectFlowRows(legacyDb).map(rowToFlowRecord);
  } finally {
    legacyDb.close();
  }
  runOpenClawStateWriteTransaction(
    (database) => {
      for (const flow of flows) {
        upsertFlowRow(database.db, bindFlowRecord(flow));
      }
    },
    { env },
  );
  return {
    importedFlows: flows.length,
    removedSource: removeSqliteSidecars(sourcePath),
    sourcePath,
  };
}

export function removeLegacyTaskFlowRegistrySidecar(env: NodeJS.ProcessEnv = process.env): {
  removedSource: boolean;
  sourcePath: string;
} {
  const sourcePath = resolveLegacyTaskFlowRegistrySqlitePath(env);
  return {
    removedSource: removeSqliteSidecars(sourcePath),
    sourcePath,
  };
}
