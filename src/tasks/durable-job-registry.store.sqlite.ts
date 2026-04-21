import { chmodSync, existsSync, mkdirSync } from "node:fs";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  resolveDurableJobRegistryDir,
  resolveDurableJobRegistrySqlitePath,
} from "./durable-job-registry.paths.js";
import type { DurableJobRegistryStoreSnapshot } from "./durable-job-registry.store.types.js";
import type {
  DurableJobBacking,
  DurableJobNotifyPolicy,
  DurableJobRecord,
  DurableJobSource,
  DurableJobStatus,
  DurableJobStopCondition,
  DurableJobTransitionDisposition,
  DurableJobTransitionRecord,
} from "./durable-job-registry.types.js";

type DurableJobRow = {
  job_id: string;
  title: string;
  goal: string;
  owner_session_key: string;
  requester_origin_json: string | null;
  source_json: string | null;
  status: DurableJobStatus;
  stop_condition_json: string;
  notify_policy_json: string;
  current_step: string | null;
  summary: string | null;
  next_wake_at: number | bigint | null;
  last_user_update_at: number | bigint | null;
  backing_task_flow_id: string | null;
  backing_cron_job_ids_json: string | null;
  backing_child_task_ids_json: string | null;
  backing_child_session_keys_json: string | null;
  audit_created_at: number | bigint;
  audit_updated_at: number | bigint;
  audit_created_by: string | null;
  audit_revision: number | bigint;
};

type DurableJobTransitionRow = {
  transition_id: string;
  job_id: string;
  from_status: DurableJobStatus | null;
  to_status: DurableJobStatus;
  reason: string | null;
  at: number | bigint;
  actor: string | null;
  disposition_json: string | null;
  revision: number | bigint | null;
};

type DurableJobRegistryStatements = {
  selectJobs: StatementSync;
  selectTransitions: StatementSync;
  upsertJob: StatementSync;
  deleteJob: StatementSync;
  clearJobs: StatementSync;
  clearTransitions: StatementSync;
  appendTransition: StatementSync;
};

type DurableJobRegistryDatabase = {
  db: DatabaseSync;
  path: string;
  statements: DurableJobRegistryStatements;
};

let cachedDatabase: DurableJobRegistryDatabase | null = null;
const DURABLE_JOB_REGISTRY_DIR_MODE = 0o700;
const DURABLE_JOB_REGISTRY_FILE_MODE = 0o600;
const DURABLE_JOB_REGISTRY_SIDECAR_SUFFIXES = ["", "-shm", "-wal"] as const;

function normalizeNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function serializeJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonValue(raw: string | null): unknown {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function rowToBacking(row: DurableJobRow): DurableJobBacking {
  const cronJobIds = parseJsonValue(row.backing_cron_job_ids_json) as string[] | undefined;
  const childTaskIds = parseJsonValue(row.backing_child_task_ids_json) as string[] | undefined;
  const childSessionKeys = parseJsonValue(row.backing_child_session_keys_json) as
    | string[]
    | undefined;
  return {
    ...(row.backing_task_flow_id ? { taskFlowId: row.backing_task_flow_id } : {}),
    ...(cronJobIds ? { cronJobIds } : {}),
    ...(childTaskIds ? { childTaskIds } : {}),
    ...(childSessionKeys ? { childSessionKeys } : {}),
  };
}

function rowToDurableJobRecord(row: DurableJobRow): DurableJobRecord {
  const requesterOrigin = parseJsonValue(row.requester_origin_json) as DeliveryContext | undefined;
  const source = parseJsonValue(row.source_json) as DurableJobSource | undefined;
  const stopCondition = parseJsonValue(row.stop_condition_json) as
    | DurableJobStopCondition
    | undefined;
  const notifyPolicy = parseJsonValue(row.notify_policy_json) as DurableJobNotifyPolicy | undefined;
  return {
    jobId: row.job_id,
    title: row.title,
    goal: row.goal,
    ownerSessionKey: row.owner_session_key,
    ...(requesterOrigin ? { requesterOrigin } : {}),
    ...(source ? { source } : {}),
    status: row.status,
    stopCondition: stopCondition ?? { kind: "unknown" },
    notifyPolicy: notifyPolicy ?? { kind: "unknown" },
    ...(row.current_step ? { currentStep: row.current_step } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(normalizeNumber(row.next_wake_at) != null
      ? { nextWakeAt: normalizeNumber(row.next_wake_at)! }
      : {}),
    ...(normalizeNumber(row.last_user_update_at) != null
      ? { lastUserUpdateAt: normalizeNumber(row.last_user_update_at)! }
      : {}),
    backing: rowToBacking(row),
    audit: {
      createdAt: normalizeNumber(row.audit_created_at) ?? 0,
      updatedAt: normalizeNumber(row.audit_updated_at) ?? 0,
      ...(row.audit_created_by ? { createdBy: row.audit_created_by } : {}),
      revision: normalizeNumber(row.audit_revision) ?? 0,
    },
  };
}

function rowToDurableJobTransitionRecord(row: DurableJobTransitionRow): DurableJobTransitionRecord {
  const disposition = parseJsonValue(row.disposition_json) as
    | DurableJobTransitionDisposition
    | undefined;
  return {
    transitionId: row.transition_id,
    jobId: row.job_id,
    ...(row.from_status ? { from: row.from_status } : {}),
    to: row.to_status,
    ...(row.reason ? { reason: row.reason } : {}),
    at: normalizeNumber(row.at) ?? 0,
    ...(row.actor ? { actor: row.actor } : {}),
    ...(disposition ? { disposition } : {}),
    ...(normalizeNumber(row.revision) != null ? { revision: normalizeNumber(row.revision)! } : {}),
  };
}

function bindDurableJobRecord(record: DurableJobRecord) {
  return {
    job_id: record.jobId,
    title: record.title,
    goal: record.goal,
    owner_session_key: record.ownerSessionKey,
    requester_origin_json: serializeJson(record.requesterOrigin),
    source_json: serializeJson(record.source),
    status: record.status,
    stop_condition_json: JSON.stringify(record.stopCondition),
    notify_policy_json: JSON.stringify(record.notifyPolicy),
    current_step: record.currentStep ?? null,
    summary: record.summary ?? null,
    next_wake_at: record.nextWakeAt ?? null,
    last_user_update_at: record.lastUserUpdateAt ?? null,
    backing_task_flow_id: record.backing.taskFlowId ?? null,
    backing_cron_job_ids_json: serializeJson(record.backing.cronJobIds),
    backing_child_task_ids_json: serializeJson(record.backing.childTaskIds),
    backing_child_session_keys_json: serializeJson(record.backing.childSessionKeys),
    audit_created_at: record.audit.createdAt,
    audit_updated_at: record.audit.updatedAt,
    audit_created_by: record.audit.createdBy ?? null,
    audit_revision: record.audit.revision,
  };
}

function bindDurableJobTransitionRecord(record: DurableJobTransitionRecord) {
  return {
    transition_id: record.transitionId,
    job_id: record.jobId,
    from_status: record.from ?? null,
    to_status: record.to,
    reason: record.reason ?? null,
    at: record.at,
    actor: record.actor ?? null,
    disposition_json: serializeJson(record.disposition),
    revision: record.revision ?? null,
  };
}

function createStatements(db: DatabaseSync): DurableJobRegistryStatements {
  return {
    selectJobs: db.prepare(`
      SELECT
        job_id,
        title,
        goal,
        owner_session_key,
        requester_origin_json,
        source_json,
        status,
        stop_condition_json,
        notify_policy_json,
        current_step,
        summary,
        next_wake_at,
        last_user_update_at,
        backing_task_flow_id,
        backing_cron_job_ids_json,
        backing_child_task_ids_json,
        backing_child_session_keys_json,
        audit_created_at,
        audit_updated_at,
        audit_created_by,
        audit_revision
      FROM durable_jobs
      ORDER BY audit_created_at ASC, job_id ASC
    `),
    selectTransitions: db.prepare(`
      SELECT
        transition_id,
        job_id,
        from_status,
        to_status,
        reason,
        at,
        actor,
        disposition_json,
        revision
      FROM durable_job_transitions
      ORDER BY at ASC, transition_id ASC
    `),
    upsertJob: db.prepare(`
      INSERT INTO durable_jobs (
        job_id,
        title,
        goal,
        owner_session_key,
        requester_origin_json,
        source_json,
        status,
        stop_condition_json,
        notify_policy_json,
        current_step,
        summary,
        next_wake_at,
        last_user_update_at,
        backing_task_flow_id,
        backing_cron_job_ids_json,
        backing_child_task_ids_json,
        backing_child_session_keys_json,
        audit_created_at,
        audit_updated_at,
        audit_created_by,
        audit_revision
      ) VALUES (
        @job_id,
        @title,
        @goal,
        @owner_session_key,
        @requester_origin_json,
        @source_json,
        @status,
        @stop_condition_json,
        @notify_policy_json,
        @current_step,
        @summary,
        @next_wake_at,
        @last_user_update_at,
        @backing_task_flow_id,
        @backing_cron_job_ids_json,
        @backing_child_task_ids_json,
        @backing_child_session_keys_json,
        @audit_created_at,
        @audit_updated_at,
        @audit_created_by,
        @audit_revision
      )
      ON CONFLICT(job_id) DO UPDATE SET
        title = excluded.title,
        goal = excluded.goal,
        owner_session_key = excluded.owner_session_key,
        requester_origin_json = excluded.requester_origin_json,
        source_json = excluded.source_json,
        status = excluded.status,
        stop_condition_json = excluded.stop_condition_json,
        notify_policy_json = excluded.notify_policy_json,
        current_step = excluded.current_step,
        summary = excluded.summary,
        next_wake_at = excluded.next_wake_at,
        last_user_update_at = excluded.last_user_update_at,
        backing_task_flow_id = excluded.backing_task_flow_id,
        backing_cron_job_ids_json = excluded.backing_cron_job_ids_json,
        backing_child_task_ids_json = excluded.backing_child_task_ids_json,
        backing_child_session_keys_json = excluded.backing_child_session_keys_json,
        audit_created_at = excluded.audit_created_at,
        audit_updated_at = excluded.audit_updated_at,
        audit_created_by = excluded.audit_created_by,
        audit_revision = excluded.audit_revision
    `),
    deleteJob: db.prepare(`DELETE FROM durable_jobs WHERE job_id = ?`),
    clearJobs: db.prepare(`DELETE FROM durable_jobs`),
    clearTransitions: db.prepare(`DELETE FROM durable_job_transitions`),
    appendTransition: db.prepare(`
      INSERT INTO durable_job_transitions (
        transition_id,
        job_id,
        from_status,
        to_status,
        reason,
        at,
        actor,
        disposition_json,
        revision
      ) VALUES (
        @transition_id,
        @job_id,
        @from_status,
        @to_status,
        @reason,
        @at,
        @actor,
        @disposition_json,
        @revision
      )
    `),
  };
}

function hasTableColumn(db: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS durable_jobs (
      job_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      owner_session_key TEXT NOT NULL,
      requester_origin_json TEXT,
      source_json TEXT,
      status TEXT NOT NULL,
      stop_condition_json TEXT NOT NULL,
      notify_policy_json TEXT NOT NULL,
      current_step TEXT,
      summary TEXT,
      next_wake_at INTEGER,
      last_user_update_at INTEGER,
      backing_task_flow_id TEXT,
      backing_cron_job_ids_json TEXT,
      backing_child_task_ids_json TEXT,
      backing_child_session_keys_json TEXT,
      audit_created_at INTEGER NOT NULL,
      audit_updated_at INTEGER NOT NULL,
      audit_created_by TEXT,
      audit_revision INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS durable_job_transitions (
      transition_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      at INTEGER NOT NULL,
      actor TEXT,
      disposition_json TEXT,
      revision INTEGER,
      FOREIGN KEY(job_id) REFERENCES durable_jobs(job_id) ON DELETE CASCADE
    );
  `);
  if (!hasTableColumn(db, "durable_jobs", "requester_origin_json")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN requester_origin_json TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "source_json")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN source_json TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "current_step")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN current_step TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "summary")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN summary TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "next_wake_at")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN next_wake_at INTEGER;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "last_user_update_at")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN last_user_update_at INTEGER;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "backing_task_flow_id")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN backing_task_flow_id TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "backing_cron_job_ids_json")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN backing_cron_job_ids_json TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "backing_child_task_ids_json")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN backing_child_task_ids_json TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "backing_child_session_keys_json")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN backing_child_session_keys_json TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "audit_created_at")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN audit_created_at INTEGER;`);
    db.exec(
      `UPDATE durable_jobs SET audit_created_at = audit_updated_at WHERE audit_created_at IS NULL;`,
    );
  }
  if (!hasTableColumn(db, "durable_jobs", "audit_updated_at")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN audit_updated_at INTEGER;`);
    db.exec(
      `UPDATE durable_jobs SET audit_updated_at = audit_created_at WHERE audit_updated_at IS NULL;`,
    );
  }
  if (!hasTableColumn(db, "durable_jobs", "audit_created_by")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN audit_created_by TEXT;`);
  }
  if (!hasTableColumn(db, "durable_jobs", "audit_revision")) {
    db.exec(`ALTER TABLE durable_jobs ADD COLUMN audit_revision INTEGER;`);
    db.exec(`UPDATE durable_jobs SET audit_revision = 0 WHERE audit_revision IS NULL;`);
  }
  if (!hasTableColumn(db, "durable_job_transitions", "disposition_json")) {
    db.exec(`ALTER TABLE durable_job_transitions ADD COLUMN disposition_json TEXT;`);
  }
  if (!hasTableColumn(db, "durable_job_transitions", "revision")) {
    db.exec(`ALTER TABLE durable_job_transitions ADD COLUMN revision INTEGER;`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_durable_jobs_status ON durable_jobs(status);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_durable_jobs_owner ON durable_jobs(owner_session_key);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_durable_jobs_updated ON durable_jobs(audit_updated_at);`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_durable_job_transitions_job ON durable_job_transitions(job_id, at);`,
  );
}

function ensureDurableJobRegistryPermissions(pathname: string) {
  const dir = resolveDurableJobRegistryDir(process.env);
  mkdirSync(dir, { recursive: true, mode: DURABLE_JOB_REGISTRY_DIR_MODE });
  chmodSync(dir, DURABLE_JOB_REGISTRY_DIR_MODE);
  for (const suffix of DURABLE_JOB_REGISTRY_SIDECAR_SUFFIXES) {
    const candidate = `${pathname}${suffix}`;
    if (!existsSync(candidate)) {
      continue;
    }
    chmodSync(candidate, DURABLE_JOB_REGISTRY_FILE_MODE);
  }
}

function openDurableJobRegistryDatabase(): DurableJobRegistryDatabase {
  const pathname = resolveDurableJobRegistrySqlitePath(process.env);
  if (cachedDatabase && cachedDatabase.path === pathname) {
    return cachedDatabase;
  }
  if (cachedDatabase) {
    cachedDatabase.db.close();
    cachedDatabase = null;
  }

  ensureDurableJobRegistryPermissions(pathname);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(pathname);
  db.exec(`PRAGMA journal_mode = WAL;`);
  db.exec(`PRAGMA synchronous = NORMAL;`);
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`PRAGMA busy_timeout = 5000;`);
  ensureSchema(db);
  ensureDurableJobRegistryPermissions(pathname);
  cachedDatabase = {
    db,
    path: pathname,
    statements: createStatements(db),
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (statements: DurableJobRegistryStatements) => void) {
  const { db, path, statements } = openDurableJobRegistryDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    write(statements);
    db.exec("COMMIT");
    ensureDurableJobRegistryPermissions(path);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function loadDurableJobRegistryStateFromSqlite(): DurableJobRegistryStoreSnapshot {
  const { statements } = openDurableJobRegistryDatabase();
  const jobs = (statements.selectJobs.all() as DurableJobRow[]).map((row) =>
    rowToDurableJobRecord(row),
  );
  const transitionRows = statements.selectTransitions.all() as DurableJobTransitionRow[];
  const transitionsByJobId = new Map<string, DurableJobTransitionRecord[]>();
  for (const row of transitionRows) {
    const transition = rowToDurableJobTransitionRecord(row);
    const existing = transitionsByJobId.get(transition.jobId);
    if (existing) {
      existing.push(transition);
    } else {
      transitionsByJobId.set(transition.jobId, [transition]);
    }
  }
  return {
    jobs: new Map(jobs.map((job) => [job.jobId, job])),
    transitionsByJobId,
  };
}

export function saveDurableJobRegistryStateToSqlite(snapshot: DurableJobRegistryStoreSnapshot) {
  withWriteTransaction((statements) => {
    statements.clearTransitions.run();
    statements.clearJobs.run();
    for (const job of snapshot.jobs.values()) {
      statements.upsertJob.run(bindDurableJobRecord(job));
    }
    for (const transitions of snapshot.transitionsByJobId.values()) {
      for (const transition of transitions) {
        statements.appendTransition.run(bindDurableJobTransitionRecord(transition));
      }
    }
  });
}

export function upsertDurableJobRegistryRecordToSqlite(job: DurableJobRecord) {
  const store = openDurableJobRegistryDatabase();
  store.statements.upsertJob.run(bindDurableJobRecord(job));
  ensureDurableJobRegistryPermissions(store.path);
}

export function deleteDurableJobRegistryRecordFromSqlite(jobId: string) {
  const store = openDurableJobRegistryDatabase();
  store.statements.deleteJob.run(jobId);
  ensureDurableJobRegistryPermissions(store.path);
}

export function appendDurableJobTransitionToSqlite(transition: DurableJobTransitionRecord) {
  const store = openDurableJobRegistryDatabase();
  store.statements.appendTransition.run(bindDurableJobTransitionRecord(transition));
  ensureDurableJobRegistryPermissions(store.path);
}

export function closeDurableJobRegistrySqliteStore() {
  if (!cachedDatabase) {
    return;
  }
  cachedDatabase.db.close();
  cachedDatabase = null;
}
