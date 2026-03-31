import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { resolveFlowRegistryDir, resolveFlowRegistrySqlitePath } from "./flow-registry.paths.js";
import type { FlowRegistryStoreSnapshot } from "./flow-registry.store.js";
import type { FlowOutputBag, FlowRecord, FlowShape } from "./flow-registry.types.js";

type FlowRegistryRow = {
  flow_id: string;
  shape: FlowShape | null;
  owner_session_key: string;
  requester_origin_json: string | null;
  status: FlowRecord["status"];
  notify_policy: FlowRecord["notifyPolicy"];
  goal: string;
  current_step: string | null;
  waiting_on_task_id: string | null;
  outputs_json: string | null;
  blocked_task_id: string | null;
  blocked_summary: string | null;
  created_at: number | bigint;
  updated_at: number | bigint;
  ended_at: number | bigint | null;
};

type FlowRegistryStatements = {
  selectAll: StatementSync;
  upsertRow: StatementSync;
  deleteRow: StatementSync;
  clearRows: StatementSync;
};

type FlowRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  statements: FlowRegistryStatements;
};

let cachedDatabase: FlowRegistryDatabase | null = null;
const FLOW_REGISTRY_DIR_MODE = 0o700;
const FLOW_REGISTRY_FILE_MODE = 0o600;
const FLOW_REGISTRY_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

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

function rowToFlowRecord(row: FlowRegistryRow): FlowRecord {
  const endedAt = normalizeNumber(row.ended_at);
  const requesterOrigin = parseJsonValue<DeliveryContext>(row.requester_origin_json);
  const outputs = parseJsonValue<FlowOutputBag>(row.outputs_json);
  return {
    flowId: row.flow_id,
    shape: row.shape === "linear" ? "linear" : "single_task",
    ownerSessionKey: row.owner_session_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    status: row.status,
    notifyPolicy: row.notify_policy,
    goal: row.goal,
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.waiting_on_task_id ? { waitingOnTaskId: row.waiting_on_task_id } : {}),
    ...(outputs ? { outputs } : {}),
    ...(row.blocked_task_id ? { blockedTaskId: row.blocked_task_id } : {}),
    ...(row.blocked_summary ? { blockedSummary: row.blocked_summary } : {}),
    createdAt: normalizeNumber(row.created_at) ?? 0,
    updatedAt: normalizeNumber(row.updated_at) ?? 0,
    ...(endedAt != null ? { endedAt } : {}),
  };
}

function bindFlowRecord(record: FlowRecord) {
  return {
    flow_id: record.flowId,
    shape: record.shape,
    owner_session_key: record.ownerSessionKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    status: record.status,
    notify_policy: record.notifyPolicy,
    goal: record.goal,
    current_step: record.currentStep ?? null,
    waiting_on_task_id: record.waitingOnTaskId ?? null,
    outputs_json: serializeJson(record.outputs),
    blocked_task_id: record.blockedTaskId ?? null,
    blocked_summary: record.blockedSummary ?? null,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ended_at: record.endedAt ?? null,
  };
}

function createStatements(db: DatabaseSync): FlowRegistryStatements {
  return {
    selectAll: db.prepare(`
      SELECT
        flow_id,
        shape,
        owner_session_key,
        requester_origin_json,
        status,
        notify_policy,
        goal,
        current_step,
        waiting_on_task_id,
        outputs_json,
        blocked_task_id,
        blocked_summary,
        created_at,
        updated_at,
        ended_at
      FROM flow_runs
      ORDER BY created_at ASC, flow_id ASC
    `),
    upsertRow: db.prepare(`
      INSERT INTO flow_runs (
        flow_id,
        shape,
        owner_session_key,
        requester_origin_json,
        status,
        notify_policy,
        goal,
        current_step,
        waiting_on_task_id,
        outputs_json,
        blocked_task_id,
        blocked_summary,
        created_at,
        updated_at,
        ended_at
      ) VALUES (
        @flow_id,
        @shape,
        @owner_session_key,
        @requester_origin_json,
        @status,
        @notify_policy,
        @goal,
        @current_step,
        @waiting_on_task_id,
        @outputs_json,
        @blocked_task_id,
        @blocked_summary,
        @created_at,
        @updated_at,
        @ended_at
      )
      ON CONFLICT(flow_id) DO UPDATE SET
        shape = excluded.shape,
        owner_session_key = excluded.owner_session_key,
        requester_origin_json = excluded.requester_origin_json,
        status = excluded.status,
        notify_policy = excluded.notify_policy,
        goal = excluded.goal,
        current_step = excluded.current_step,
        waiting_on_task_id = excluded.waiting_on_task_id,
        outputs_json = excluded.outputs_json,
        blocked_task_id = excluded.blocked_task_id,
        blocked_summary = excluded.blocked_summary,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        ended_at = excluded.ended_at
    `),
    deleteRow: db.prepare(`DELETE FROM flow_runs WHERE flow_id = ?`),
    clearRows: db.prepare(`DELETE FROM flow_runs`),
  };
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS flow_runs (
      flow_id TEXT PRIMARY KEY,
      shape TEXT NOT NULL,
      owner_session_key TEXT NOT NULL,
      requester_origin_json TEXT,
      status TEXT NOT NULL,
      notify_policy TEXT NOT NULL,
      goal TEXT NOT NULL,
      current_step TEXT,
      waiting_on_task_id TEXT,
      outputs_json TEXT,
      blocked_task_id TEXT,
      blocked_summary TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ended_at INTEGER
    );
  `);
  ensureColumn(db, "flow_runs", "shape", "TEXT");
  ensureColumn(db, "flow_runs", "waiting_on_task_id", "TEXT");
  ensureColumn(db, "flow_runs", "outputs_json", "TEXT");
  ensureColumn(db, "flow_runs", "blocked_task_id", "TEXT");
  ensureColumn(db, "flow_runs", "blocked_summary", "TEXT");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_flow_runs_owner_session_key ON flow_runs(owner_session_key);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_flow_runs_updated_at ON flow_runs(updated_at);`);
}

function ensureColumn(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  columnDefinition: string,
) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition};`);
}

function ensureFlowRegistryPermissions(pathname: string) {
  const dir = resolveFlowRegistryDir(process.env);
  mkdirSync(dir, { recursive: true, mode: FLOW_REGISTRY_DIR_MODE });
  chmodSync(dir, FLOW_REGISTRY_DIR_MODE);
  for (const suffix of FLOW_REGISTRY_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, FLOW_REGISTRY_FILE_MODE);
  }
}

function openFlowRegistryDatabase(): FlowRegistryDatabase {
  const pathname = resolveFlowRegistrySqlitePath(process.env);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.db.close();
    cachedDatabase = null;
  }
  ensureFlowRegistryPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensureFlowRegistryPermissions(pathname);
  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (statements: FlowRegistryStatements) => void) {
  const { db, path, statements } = openFlowRegistryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    write(statements);
    db.exec("COMMIT");
    ensureFlowRegistryPermissions(path);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadFlowRegistryStateFromSqlite(): FlowRegistryStoreSnapshot {
  const { statements } = openFlowRegistryDatabase();
  const rows = statements.selectAll.all() as FlowRegistryRow[];
  return {
    flows: new Map(rows.map((row) => [row.flow_id, rowToFlowRecord(row)])),
  };
}

export function saveFlowRegistryStateToSqlite(snapshot: FlowRegistryStoreSnapshot) {
  withWriteTransaction((statements) => {
    statements.clearRows.run();
    for (const flow of snapshot.flows.values()) {
      statements.upsertRow.run(bindFlowRecord(flow));
    }
  });
}

export function upsertFlowRegistryRecordToSqlite(flow: FlowRecord) {
  const store = openFlowRegistryDatabase();
  store.statements.upsertRow.run(bindFlowRecord(flow));
  ensureFlowRegistryPermissions(store.path);
}

export function deleteFlowRegistryRecordFromSqlite(flowId: string) {
  const store = openFlowRegistryDatabase();
  store.statements.deleteRow.run(flowId);
  ensureFlowRegistryPermissions(store.path);
}

export function closeFlowRegistrySqliteStore() {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.db.close();
  cachedDatabase = null;
}
