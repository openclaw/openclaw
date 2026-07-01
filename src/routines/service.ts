/** Durable routine operations built on top of the canonical cron scheduler. */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { cronStoreKey } from "../cron/store/key.js";
import type {
  CronDelivery,
  CronJob,
  CronJobCreate,
  CronPayload,
  CronRunStatus,
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
} from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { sanitizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";

type RoutineOwner = {
  agentId?: string;
  sessionKey?: string;
};

type RoutineTarget = {
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  delivery?: CronDelivery;
};

type RoutineScheduleTrigger = {
  kind: "schedule";
  schedule: CronSchedule;
  cronJobId: string;
  cronStoreKey?: string;
};

type RoutineRecord = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  owner: RoutineOwner;
  target: RoutineTarget;
  trigger: RoutineScheduleTrigger;
  action: CronPayload;
  createdAtMs: number;
  updatedAtMs: number;
};

export type RoutineCreateInput = {
  id?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  owner?: RoutineOwner;
  target?: Partial<RoutineTarget>;
  trigger: { kind: "schedule"; schedule: CronSchedule };
  action: CronPayload;
};

export type RoutineListOptions = {
  includeDisabled?: boolean;
  agentId?: string;
  query?: string;
  limit?: number;
  offset?: number;
};

type RoutineRuntimeStatus = {
  status: "enabled" | "disabled" | "running" | "missing";
  backing: "linked" | "missing";
  enabled: boolean;
  cronJobId?: string;
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: CronRunStatus;
  lastError?: string;
};

type RoutineView = RoutineRecord & {
  status: RoutineRuntimeStatus;
};

type RoutineCreateResult = {
  routine: RoutineView;
  created: boolean;
  idempotent: boolean;
};

type RoutineSetEnabledResult = {
  routine: RoutineView;
  changed: boolean;
};

type RoutineDeleteResult = {
  id: string;
  deleted: boolean;
};

type RoutineCronContext = {
  cron: CronServiceContract;
  cronStorePath?: string;
};

type RoutineRecordsTable = OpenClawStateKyselyDatabase["routine_records"];
type RoutineStoreDatabase = Pick<OpenClawStateKyselyDatabase, "routine_records">;
type RoutineRecordRow = Selectable<RoutineRecordsTable>;

type RoutineRegistryDatabase = {
  db: DatabaseSync;
  path: string;
};

type NormalizedRoutineCreate = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  cronInput: CronJobCreate;
  target: RoutineTarget;
};

const ROUTINE_SELECT_COLUMNS = [
  "routine_id",
  "name",
  "description",
  "owner_agent_id",
  "owner_session_key",
  "trigger_kind",
  "backing_cron_store_key",
  "backing_cron_job_id",
  "enabled",
  "created_at_ms",
  "updated_at_ms",
  "routine_json",
] as const;

let cachedDatabase: RoutineRegistryDatabase | null = null;
const routineMutationLocks = new Map<string, Promise<unknown>>();

async function withRoutineMutationLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const previous = routineMutationLocks.get(id);
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = (previous ?? Promise.resolve()).catch(() => undefined).then(() => current);
  routineMutationLocks.set(id, chained);
  await previous?.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (routineMutationLocks.get(id) === chained) {
      routineMutationLocks.delete(id);
    }
  }
}

function getRoutineStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<RoutineStoreDatabase>(db);
}

function openRoutineRegistryDatabase(): RoutineRegistryDatabase {
  const database = openOpenClawStateDatabase();
  if (cachedDatabase && cachedDatabase.path === database.path && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }
  cachedDatabase = {
    db: database.db,
    path: database.path,
  };
  return cachedDatabase;
}

function parseRoutineRecord(row: RoutineRecordRow): RoutineRecord {
  const parsed = JSON.parse(row.routine_json) as RoutineRecord;
  return {
    ...parsed,
    id: row.routine_id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.enabled === 1,
    createdAtMs: normalizeSqliteNumber(row.created_at_ms) ?? parsed.createdAtMs,
    updatedAtMs: normalizeSqliteNumber(row.updated_at_ms) ?? parsed.updatedAtMs,
  };
}

function bindRoutineRecord(record: RoutineRecord): Insertable<RoutineRecordsTable> {
  return {
    routine_id: record.id,
    name: record.name,
    description: record.description ?? null,
    owner_agent_id: record.owner.agentId ?? null,
    owner_session_key: record.owner.sessionKey ?? null,
    trigger_kind: record.trigger.kind,
    backing_cron_store_key: record.trigger.cronStoreKey ?? null,
    backing_cron_job_id: record.trigger.cronJobId,
    enabled: record.enabled ? 1 : 0,
    created_at_ms: record.createdAtMs,
    updated_at_ms: record.updatedAtMs,
    routine_json: JSON.stringify(record),
  };
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function normalizeOffset(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function getRoutineRecordFromSqlite(id: string): RoutineRecord | undefined {
  const routineId = id.trim();
  if (!routineId) {
    return undefined;
  }
  const { db } = openRoutineRegistryDatabase();
  const row = executeSqliteQuerySync(
    db,
    getRoutineStoreKysely(db)
      .selectFrom("routine_records")
      .select(ROUTINE_SELECT_COLUMNS)
      .where("routine_id", "=", routineId)
      .limit(1),
  ).rows[0];
  return row ? parseRoutineRecord(row) : undefined;
}

function listRoutineRecordsFromSqlite(options: RoutineListOptions = {}): RoutineRecord[] {
  const { db } = openRoutineRegistryDatabase();
  let query = getRoutineStoreKysely(db)
    .selectFrom("routine_records")
    .select(ROUTINE_SELECT_COLUMNS)
    .orderBy("updated_at_ms", "desc")
    .orderBy("routine_id", "asc");

  const rawAgentId = normalizeOptionalString(options.agentId);
  if (rawAgentId) {
    query = query.where("owner_agent_id", "=", sanitizeAgentId(rawAgentId));
  }
  const search = options.query?.trim();
  if (search) {
    const like = `%${search}%`;
    query = query.where((eb) => eb.or([eb("name", "like", like), eb("description", "like", like)]));
  }
  return executeSqliteQuerySync(db, query).rows.map(parseRoutineRecord);
}

function upsertRoutineRecordToSqlite(record: RoutineRecord): void {
  const row = bindRoutineRecord(record);
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getRoutineStoreKysely(db)
        .insertInto("routine_records")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("routine_id").doUpdateSet({
            name: (eb) => eb.ref("excluded.name"),
            description: (eb) => eb.ref("excluded.description"),
            owner_agent_id: (eb) => eb.ref("excluded.owner_agent_id"),
            owner_session_key: (eb) => eb.ref("excluded.owner_session_key"),
            trigger_kind: (eb) => eb.ref("excluded.trigger_kind"),
            backing_cron_store_key: (eb) => eb.ref("excluded.backing_cron_store_key"),
            backing_cron_job_id: (eb) => eb.ref("excluded.backing_cron_job_id"),
            enabled: (eb) => eb.ref("excluded.enabled"),
            created_at_ms: (eb) => eb.ref("excluded.created_at_ms"),
            updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
            routine_json: (eb) => eb.ref("excluded.routine_json"),
          }),
        ),
    );
  });
}

function deleteRoutineRecordFromSqlite(id: string): boolean {
  const routineId = id.trim();
  if (!routineId) {
    return false;
  }
  let deleted = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getRoutineStoreKysely(db).deleteFrom("routine_records").where("routine_id", "=", routineId),
    );
    deleted = Number(result.numAffectedRows ?? 0n) > 0;
  });
  return deleted;
}

function createRoutineId(): string {
  return `routine-${crypto.randomUUID()}`;
}

function requireNonBlankString(value: string | undefined, label: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeRoutineId(value: string | undefined): string {
  return normalizeOptionalString(value) ?? createRoutineId();
}

function createRoutineCronJobId(routineId: string): string {
  const digest = crypto.createHash("sha256").update(routineId).digest("hex").slice(0, 32);
  return `routine-cron-${digest}`;
}

function normalizeRoutineOwner(input: RoutineCreateInput): {
  agentId?: string;
  sessionKey?: string;
} {
  const rawAgentId = normalizeOptionalString(input.owner?.agentId);
  const sessionKey = normalizeOptionalString(input.owner?.sessionKey);
  return {
    ...(rawAgentId ? { agentId: sanitizeAgentId(rawAgentId) } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function inferSessionTarget(payload: CronPayload): CronSessionTarget {
  return payload.kind === "systemEvent" ? "main" : "isolated";
}

function normalizeRoutineCreateInput(input: RoutineCreateInput): NormalizedRoutineCreate {
  const id = normalizeRoutineId(input.id);
  const name = requireNonBlankString(input.name, "routine name");
  const description = normalizeOptionalString(input.description);
  const owner = normalizeRoutineOwner(input);
  if (input.trigger.kind !== "schedule") {
    throw new Error(`unsupported routine trigger: ${input.trigger.kind}`);
  }
  const sessionTarget = input.target?.sessionTarget ?? inferSessionTarget(input.action);
  const wakeMode = input.target?.wakeMode ?? "now";
  const cronInput = normalizeCronJobCreate(
    {
      name,
      description,
      enabled: input.enabled ?? true,
      deleteAfterRun: false,
      agentId: owner.agentId,
      sessionKey: owner.sessionKey,
      schedule: input.trigger.schedule,
      sessionTarget,
      wakeMode,
      payload: input.action,
      delivery: input.target?.delivery,
    },
    {
      sessionContext: { sessionKey: owner.sessionKey },
    },
  );
  if (!cronInput) {
    throw new Error("invalid routine schedule or action");
  }
  const cronInputWithId = { ...cronInput, id: createRoutineCronJobId(id) };
  return {
    id,
    name: cronInputWithId.name,
    ...(cronInputWithId.description ? { description: cronInputWithId.description } : {}),
    enabled: cronInputWithId.enabled ?? true,
    cronInput: cronInputWithId,
    target: {
      sessionTarget: cronInputWithId.sessionTarget,
      wakeMode: cronInputWithId.wakeMode,
      ...(cronInputWithId.delivery ? { delivery: cronInputWithId.delivery } : {}),
    },
  };
}

export function normalizeRoutineCronCreateInput(input: RoutineCreateInput): CronJobCreate {
  return normalizeRoutineCreateInput(input).cronInput;
}

function routineIntentSignature(record: RoutineRecord): string {
  return stableStringify({
    name: record.name,
    description: record.description,
    owner: record.owner,
    target: record.target,
    trigger: {
      kind: record.trigger.kind,
      schedule: record.trigger.schedule,
    },
    action: record.action,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createRoutineIntentRecord(normalized: NormalizedRoutineCreate): RoutineRecord {
  const cronInput = normalized.cronInput;
  return {
    id: normalized.id,
    name: normalized.name,
    ...(normalized.description ? { description: normalized.description } : {}),
    enabled: normalized.enabled,
    owner: {
      ...(cronInput.agentId ? { agentId: cronInput.agentId } : {}),
      ...(cronInput.sessionKey ? { sessionKey: cronInput.sessionKey } : {}),
    },
    target: normalized.target,
    trigger: {
      kind: "schedule",
      schedule: cronInput.schedule,
      cronJobId: cronInput.id ?? createRoutineCronJobId(normalized.id),
    },
    action: cronInput.payload,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function createRoutinePendingRecord(params: {
  normalized: NormalizedRoutineCreate;
  nowMs: number;
  cronStorePath?: string;
}): RoutineRecord {
  const { cronInput, id, name, description, target } = params.normalized;
  return {
    id,
    name,
    ...(description ? { description } : {}),
    enabled: params.normalized.enabled,
    owner: {
      ...(cronInput.agentId ? { agentId: cronInput.agentId } : {}),
      ...(cronInput.sessionKey ? { sessionKey: cronInput.sessionKey } : {}),
    },
    target,
    trigger: {
      kind: "schedule",
      schedule: cronInput.schedule,
      cronJobId: cronInput.id ?? createRoutineCronJobId(id),
      ...(params.cronStorePath ? { cronStoreKey: cronStoreKey(params.cronStorePath) } : {}),
    },
    action: cronInput.payload,
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
  };
}

function createRoutineRecord(params: {
  normalized: NormalizedRoutineCreate;
  cronJob: CronJob;
  cronStorePath?: string;
  createdAtMs?: number;
}): RoutineRecord {
  const { cronInput, id, name, description, target } = params.normalized;
  const { cronJob } = params;
  return {
    id,
    name,
    ...(description ? { description } : {}),
    enabled: cronJob.enabled,
    owner: {
      ...(cronInput.agentId ? { agentId: cronInput.agentId } : {}),
      ...(cronInput.sessionKey ? { sessionKey: cronInput.sessionKey } : {}),
    },
    target,
    trigger: {
      kind: "schedule",
      schedule: cronInput.schedule,
      cronJobId: cronJob.id,
      ...(params.cronStorePath ? { cronStoreKey: cronStoreKey(params.cronStorePath) } : {}),
    },
    action: cronJob.payload,
    createdAtMs: params.createdAtMs ?? cronJob.createdAtMs,
    updatedAtMs: cronJob.updatedAtMs,
  };
}

function cronJobMap(jobs: readonly CronJob[]): Map<string, CronJob> {
  return new Map(jobs.map((job) => [job.id, job]));
}

async function readCronJobsById(cron: CronServiceContract): Promise<Map<string, CronJob>> {
  return cronJobMap(await cron.list({ includeDisabled: true }));
}

function routineStatus(record: RoutineRecord, cronJob: CronJob | undefined): RoutineRuntimeStatus {
  if (!cronJob) {
    return {
      status: "missing",
      backing: "missing",
      enabled: record.enabled,
      cronJobId: record.trigger.cronJobId,
    };
  }
  const state = cronJob.state ?? {};
  const enabled = cronJob.enabled;
  const status = state.runningAtMs ? "running" : enabled ? "enabled" : "disabled";
  return {
    status,
    backing: "linked",
    enabled,
    cronJobId: cronJob.id,
    ...(state.nextRunAtMs !== undefined ? { nextRunAtMs: state.nextRunAtMs } : {}),
    ...(state.runningAtMs !== undefined ? { runningAtMs: state.runningAtMs } : {}),
    ...(state.lastRunAtMs !== undefined ? { lastRunAtMs: state.lastRunAtMs } : {}),
    ...(state.lastRunStatus ? { lastRunStatus: state.lastRunStatus } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
  };
}

function toRoutineView(record: RoutineRecord, cronJob: CronJob | undefined): RoutineView {
  const status = routineStatus(record, cronJob);
  return {
    ...record,
    enabled: status.enabled,
    status,
  };
}

function routineCronStoreMatches(
  record: RoutineRecord,
  cronStorePath: string | undefined,
): boolean {
  return (
    !record.trigger.cronStoreKey ||
    !cronStorePath ||
    record.trigger.cronStoreKey === cronStoreKey(cronStorePath)
  );
}

function assertRoutineCronStoreActive(record: RoutineRecord, cronStorePath: string | undefined) {
  if (!routineCronStoreMatches(record, cronStorePath)) {
    throw new Error(`routine backing cron store is not active: ${record.trigger.cronJobId}`);
  }
}

function routineMissingError(id: string): Error {
  return new Error(`routine not found: ${id}`);
}

export async function listRoutines(
  options: RoutineListOptions,
  context: RoutineCronContext,
): Promise<{ routines: RoutineView[] }> {
  const records = listRoutineRecordsFromSqlite(options);
  const jobsById = await readCronJobsById(context.cron);
  const views = records.map((record) =>
    toRoutineView(record, jobsById.get(record.trigger.cronJobId)),
  );
  const filtered = options.includeDisabled
    ? views
    : views.filter((routine) => routine.status.enabled);
  const offset = normalizeOffset(options.offset) ?? 0;
  const limit = normalizeLimit(options.limit);
  return {
    routines: limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit),
  };
}

export async function inspectRoutine(
  id: string,
  context: RoutineCronContext,
): Promise<RoutineView | undefined> {
  const record = getRoutineRecordFromSqlite(id);
  if (!record) {
    return undefined;
  }
  const cronJob = await context.cron.readJob(record.trigger.cronJobId);
  return toRoutineView(record, cronJob);
}

async function ensureRoutineBackingCronJob(params: {
  record: RoutineRecord;
  normalized: NormalizedRoutineCreate;
  context: RoutineCronContext;
}): Promise<CronJob> {
  assertRoutineCronStoreActive(params.record, params.context.cronStorePath);
  const existing = await params.context.cron.readJob(params.record.trigger.cronJobId);
  if (existing) {
    return existing;
  }
  try {
    return await params.context.cron.add({
      ...params.normalized.cronInput,
      id: params.record.trigger.cronJobId,
    });
  } catch (err) {
    const created = await params.context.cron.readJob(params.record.trigger.cronJobId);
    if (created) {
      return created;
    }
    throw err;
  }
}

export async function createRoutine(
  input: RoutineCreateInput,
  context: RoutineCronContext,
): Promise<RoutineCreateResult> {
  const normalized = normalizeRoutineCreateInput(input);
  return await withRoutineMutationLock(normalized.id, async () => {
    const existing = getRoutineRecordFromSqlite(normalized.id);
    if (existing) {
      const comparable = createRoutineIntentRecord(normalized);
      if (routineIntentSignature(existing) !== routineIntentSignature(comparable)) {
        throw new Error(`routine id already exists with different intent: ${normalized.id}`);
      }
      const cronJob = await ensureRoutineBackingCronJob({ record: existing, normalized, context });
      const record = createRoutineRecord({
        normalized,
        cronJob,
        cronStorePath: context.cronStorePath,
        createdAtMs: existing.createdAtMs,
      });
      upsertRoutineRecordToSqlite(record);
      return { routine: toRoutineView(record, cronJob), created: false, idempotent: true };
    }

    const pending = createRoutinePendingRecord({
      normalized,
      nowMs: Date.now(),
      cronStorePath: context.cronStorePath,
    });
    upsertRoutineRecordToSqlite(pending);
    const cronJob = await ensureRoutineBackingCronJob({ record: pending, normalized, context });
    const record = createRoutineRecord({
      normalized,
      cronJob,
      cronStorePath: context.cronStorePath,
      createdAtMs: pending.createdAtMs,
    });
    try {
      upsertRoutineRecordToSqlite(record);
    } catch (err) {
      throw new Error(`failed to persist routine: ${formatErrorMessage(err)}`);
    }
    return {
      routine: toRoutineView(record, cronJob),
      created: true,
      idempotent: false,
    };
  });
}

export async function setRoutineEnabled(
  id: string,
  enabled: boolean,
  context: RoutineCronContext,
): Promise<RoutineSetEnabledResult> {
  return await withRoutineMutationLock(id, async () => {
    const record = getRoutineRecordFromSqlite(id);
    if (!record) {
      throw routineMissingError(id);
    }
    assertRoutineCronStoreActive(record, context.cronStorePath);
    const cronJob = await context.cron.readJob(record.trigger.cronJobId);
    if (!cronJob) {
      if (enabled) {
        throw new Error(`routine backing cron job is missing: ${record.trigger.cronJobId}`);
      }
      const disabled = { ...record, enabled: false, updatedAtMs: Date.now() };
      upsertRoutineRecordToSqlite(disabled);
      return {
        routine: toRoutineView(disabled, undefined),
        changed: record.enabled,
      };
    }
    if (cronJob.enabled !== enabled) {
      await context.cron.update(cronJob.id, { enabled });
    }
    const updatedCronJob = await context.cron.readJob(cronJob.id);
    const updatedRecord = {
      ...record,
      enabled,
      updatedAtMs: Date.now(),
    };
    upsertRoutineRecordToSqlite(updatedRecord);
    return {
      routine: toRoutineView(updatedRecord, updatedCronJob ?? { ...cronJob, enabled }),
      changed: record.enabled !== enabled || cronJob.enabled !== enabled,
    };
  });
}

export async function deleteRoutine(
  id: string,
  context: RoutineCronContext,
): Promise<RoutineDeleteResult> {
  return await withRoutineMutationLock(id, async () => {
    const record = getRoutineRecordFromSqlite(id);
    if (!record) {
      return { id, deleted: false };
    }
    assertRoutineCronStoreActive(record, context.cronStorePath);
    const cronJob = await context.cron.readJob(record.trigger.cronJobId);
    if (cronJob) {
      const result = await context.cron.remove(record.trigger.cronJobId);
      if (!result.ok || !result.removed) {
        throw new Error(`failed to remove routine backing cron job: ${record.trigger.cronJobId}`);
      }
    }
    const deleted = deleteRoutineRecordFromSqlite(record.id);
    return { id: record.id, deleted };
  });
}
