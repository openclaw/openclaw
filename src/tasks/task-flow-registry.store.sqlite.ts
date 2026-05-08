import { existsSync, rmSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { resolveLegacyTaskFlowRegistrySqlitePath } from "./task-flow-registry.paths.js";
import type { TaskFlowRegistryStoreSnapshot } from "./task-flow-registry.store.types.js";
import {
  parseOptionalTaskFlowSyncMode,
  parseTaskFlowStatus,
  type JsonValue,
  type TaskFlowRecord,
  type TaskFlowSyncMode,
} from "./task-flow-registry.types.js";
import { parseTaskNotifyPolicy } from "./task-registry.types.js";

type FlowRunsTable = OpenClawStateKyselyDatabase["flow_runs"];
type FlowRegistryStoreDatabase = Pick<OpenClawStateKyselyDatabase, "flow_runs">;

type FlowRegistryRow = Selectable<FlowRunsTable> & {
  sync_mode: string | null;
  status: string;
  notify_policy: string;
};

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

let cachedDatabase: FlowRegistryDatabase | null = null;
const SQLITE_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Persisted JSON columns are typed by the receiving field.
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

function rowToSyncMode(row: FlowRegistryRow): TaskFlowSyncMode {
  const syncMode = parseOptionalTaskFlowSyncMode(row.sync_mode);
  if (syncMode) return syncMode;
  return row.shape === "single_task" ? "task_mirrored" : "managed";
}

function rowToFlowRecord(row: FlowRegistryRow): TaskFlowRecord {
  const endedAt = normalizeNumber(row.ended_at);
  const cancelRequestedAt = normalizeNumber(row.cancel_requested_at);
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const stateJson = parseJsonValue<JsonValue>(row.state_json);
  const waitJson = parseJsonValue<JsonValue>(row.wait_json);
  return {
    flowId: row.flow_id,
    syncMode: rowToSyncMode(row),
    ownerKey: row.owner_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(row.controller_id ? { controllerId: row.controller_id } : {}),
    revision: normalizeNumber(row.revision) ?? 0,
    status: parseTaskFlowStatus(row.status),
    notifyPolicy: parseTaskNotifyPolicy(row.notify_policy),
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

function getFlowRegistryKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<FlowRegistryStoreDatabase>(db);
}

function selectFlowRows(db: DatabaseSync): FlowRegistryRow[] {
  const query = getFlowRegistryKysely(db)
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
    .orderBy("flow_id", "asc");
  return executeSqliteQuerySync<FlowRegistryRow>(db, query).rows;
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

function hasLegacyFlowRunsColumn(db: DatabaseSync, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(flow_runs)`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
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
    !hasLegacyFlowRunsColumn(db, "owner_key") &&
    hasLegacyFlowRunsColumn(db, "owner_session_key")
  ) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN owner_key TEXT;`);
    db.exec(`
      UPDATE flow_runs
      SET owner_key = owner_session_key
      WHERE owner_key IS NULL
    `);
  }
  if (!hasLegacyFlowRunsColumn(db, "shape")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN shape TEXT;`);
  }
  if (!hasLegacyFlowRunsColumn(db, "sync_mode")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN sync_mode TEXT;`);
    if (hasLegacyFlowRunsColumn(db, "shape")) {
      db.exec(`
        UPDATE flow_runs
        SET sync_mode = CASE
          WHEN shape = 'single_task' THEN 'task_mirrored'
          ELSE 'managed'
        END
        WHERE sync_mode IS NULL
      `);
    } else {
      db.exec(`
        UPDATE flow_runs
        SET sync_mode = 'managed'
        WHERE sync_mode IS NULL
      `);
    }
  }
  if (!hasLegacyFlowRunsColumn(db, "controller_id")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN controller_id TEXT;`);
  }
  db.exec(`
    UPDATE flow_runs
    SET controller_id = 'core/legacy-restored'
    WHERE sync_mode = 'managed'
      AND (controller_id IS NULL OR trim(controller_id) = '')
  `);
  if (!hasLegacyFlowRunsColumn(db, "revision")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN revision INTEGER;`);
    db.exec(`
      UPDATE flow_runs
      SET revision = 0
      WHERE revision IS NULL
    `);
  }
  if (!hasLegacyFlowRunsColumn(db, "blocked_task_id")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_task_id TEXT;`);
  }
  if (!hasLegacyFlowRunsColumn(db, "blocked_summary")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN blocked_summary TEXT;`);
  }
  if (!hasLegacyFlowRunsColumn(db, "state_json")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN state_json TEXT;`);
  }
  if (!hasLegacyFlowRunsColumn(db, "wait_json")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN wait_json TEXT;`);
  }
  if (!hasLegacyFlowRunsColumn(db, "cancel_requested_at")) {
    db.exec(`ALTER TABLE flow_runs ADD COLUMN cancel_requested_at INTEGER;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_owner_key ON flow_runs(owner_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_updated_at ON flow_runs(updated_at);`);
}

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const database = openOpenClawStateDatabase();
  const pathname = database.path;
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  cachedDatabase = {
    db: database.db,
    path: pathname,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (database: FlowRegistryDatabase) => void) {
  const database = openFlowRegistryDatabase();
  runOpenClawStateWriteTransaction(() => {
    write(database);
  });
}

export function loadTaskFlowRegistryStateFromSqlite(): TaskFlowRegistryStoreSnapshot {
  const { db } = openFlowRegistryDatabase();
  const rows = selectFlowRows(db);
  return {
    flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])),
  };
}

export function saveTaskFlowRegistryStateToSqlite(snapshot: TaskFlowRegistryStoreSnapshot) {
  withWriteTransaction(({ db }) => {
    executeSqliteQuerySync(db, getFlowRegistryKysely(db).deleteFrom("flow_runs"));
    for (const flow of snapshot.flows.values()) {
      upsertFlowRow(db, bindFlowRecord(flow));
    }
  });
}

export function upsertTaskFlowRegistryRecordToSqlite(flow: TaskFlowRecord) {
  withWriteTransaction(({ db }) => {
    upsertFlowRow(db, bindFlowRecord(flow));
  });
}

export function deleteTaskFlowRegistryRecordFromSqlite(flowId: string) {
  withWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getFlowRegistryKysely(db).deleteFrom("flow_runs").where("flow_id", "=", flowId),
    );
  });
}

export function closeTaskFlowRegistrySqliteStore() {
  cachedDatabase = null;
}

export function legacyTaskFlowRegistrySidecarExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(resolveLegacyTaskFlowRegistrySqlitePath(env));
}

function removeSqliteSidecars(pathname: string): boolean {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    rmSync(`${pathname}${suffix}`, { force: true });
  }
  return !existsSync(pathname);
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
  let importedFlows = 0;
  try {
    ensureLegacyTaskFlowRegistrySchema(legacyDb);
    const rows = selectFlowRows(legacyDb);
    const flows = rows.map(rowToFlowRecord);
    withWriteTransaction(({ db }) => {
      for (const flow of flows) {
        upsertFlowRow(db, bindFlowRecord(flow));
      }
    });
    importedFlows = flows.length;
  } finally {
    legacyDb.close();
  }
  return {
    importedFlows,
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
