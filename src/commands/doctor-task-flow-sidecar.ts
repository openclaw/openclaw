import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveLegacyTaskFlowRegistrySqlitePath } from "../tasks/task-flow-registry.paths.js";
import type { TaskFlowRecord, TaskFlowSyncMode } from "../tasks/task-flow-registry.types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  hasLegacySidecarColumn,
  normalizeSidecarNumber,
  parseSidecarJsonValue,
  removeSqliteSidecars,
  serializeSidecarJson,
} from "./doctor-sqlite-sidecar-shared.js";

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;
type FlowRegistryRow = Selectable<FlowRunsTable> & {
  sync_mode: TaskFlowSyncMode | null;
  status: TaskFlowRecord["status"];
  notify_policy: TaskFlowRecord["notifyPolicy"];
};

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryDatabase>(db);
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
    !hasLegacySidecarColumn(db, "flow_runs", "owner_key") &&
    hasLegacySidecarColumn(db, "flow_runs", "owner_session_key")
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
    if (!hasLegacySidecarColumn(db, "flow_runs", column)) {
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
  const endedAt = normalizeSidecarNumber(row.ended_at);
  const cancelRequestedAt = normalizeSidecarNumber(row.cancel_requested_at);
  const requesterOrigin = parseSidecarJsonValue<DeliveryContext>(row.requester_origin_json);
  const stateJson = parseSidecarJsonValue<TaskFlowRecord["stateJson"]>(row.state_json);
  const waitJson = parseSidecarJsonValue<TaskFlowRecord["waitJson"]>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeSidecarNumber(row.revision) ?? 0,
    status: row.status,
    notifyPolicy: row.notify_policy,
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    ...(stateJson !== undefined ? { stateJson } : {}),
    ...(waitJson !== undefined ? { waitJson } : {}),
    ...(cancelRequestedAt != null ? { cancelRequestedAt } : {}),
    createdAt: normalizeSidecarNumber(row.created_at) ?? 0,
    updatedAt: normalizeSidecarNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

function bindFlowRecord(record: TaskFlowRecord): Insertable<FlowRunsTable> {
  return {
    flow_id: record.flowId,
    sync_mode: record.syncMode,
    shape: null,
    owner_key: record.ownerKey,
    requester_origin_json: serializeSidecarJson(record.requesterOrigin),
    controller_id: record.controllerId ?? null,
    revision: record.revision,
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    state_json: serializeSidecarJson(record.stateJson),
    wait_json: serializeSidecarJson(record.waitJson),
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
