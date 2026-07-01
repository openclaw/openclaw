/** Durable routine operations built on top of the canonical cron scheduler. */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Insertable, Selectable } from "kysely";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import { parseAbsoluteTimeMs } from "../cron/parse.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import { cronStoreKey } from "../cron/store/key.js";
import type {
  CronDelivery,
  CronDeliveryStatus,
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronJobState,
  CronPayload,
  CronRunStatus,
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
} from "../cron/types.js";
import { validateScheduleTimestamp } from "../cron/validate-timestamp.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { DEFAULT_AGENT_ID, sanitizeAgentId } from "../routing/session-key.js";
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
  lastDelivered?: boolean;
  lastDeliveryStatus?: CronDeliveryStatus;
  lastDeliveryError?: string;
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
  validateCronCreate?: (input: CronJobCreate) => void | Promise<void>;
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

export class RoutineInvalidRequestError extends Error {
  readonly cause: unknown;

  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = "RoutineInvalidRequestError";
    this.cause = opts?.cause;
  }
}

const ROUTINE_SELECT_COLUMNS = ["routine_id", "backing_cron_store_key", "routine_json"] as const;

let cachedDatabase: RoutineRegistryDatabase | null = null;
const routineMutationLocks = new Map<string, Promise<unknown>>();
const DEFAULT_ROUTINE_CRON_STORE_KEY = "__default__";

export function isRoutineInvalidRequestError(err: unknown): err is RoutineInvalidRequestError {
  return err instanceof RoutineInvalidRequestError;
}

function routineInvalidRequest(message: string, cause?: unknown): RoutineInvalidRequestError {
  return new RoutineInvalidRequestError(message, cause === undefined ? undefined : { cause });
}

function routineCronStoreKey(cronStorePath: string | undefined): string {
  return cronStorePath ? cronStoreKey(cronStorePath) : DEFAULT_ROUTINE_CRON_STORE_KEY;
}

function routineMutationLockKey(storeKey: string, routineId: string): string {
  return `${storeKey}\0${routineId}`;
}

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
  const cronStoreKeyValue = row.backing_cron_store_key ?? parsed.trigger.cronStoreKey;
  return {
    ...parsed,
    id: row.routine_id,
    trigger: {
      ...parsed.trigger,
      ...(cronStoreKeyValue ? { cronStoreKey: cronStoreKeyValue } : {}),
    },
  };
}

function bindRoutineRecord(record: RoutineRecord): Insertable<RoutineRecordsTable> {
  return {
    routine_id: record.id,
    backing_cron_store_key: record.trigger.cronStoreKey ?? DEFAULT_ROUTINE_CRON_STORE_KEY,
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

function getRoutineRecordFromSqlite(id: string, storeKey: string): RoutineRecord | undefined {
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
      .where("backing_cron_store_key", "=", storeKey)
      .limit(1),
  ).rows[0];
  return row ? parseRoutineRecord(row) : undefined;
}

function listRoutineRecordsFromSqlite(storeKey: string): RoutineRecord[] {
  const { db } = openRoutineRegistryDatabase();
  const query = getRoutineStoreKysely(db)
    .selectFrom("routine_records")
    .select(ROUTINE_SELECT_COLUMNS)
    .where("backing_cron_store_key", "=", storeKey);
  return executeSqliteQuerySync(db, query)
    .rows.map(parseRoutineRecord)
    .toSorted((left, right) => {
      const byUpdated = right.updatedAtMs - left.updatedAtMs;
      return byUpdated === 0 ? left.id.localeCompare(right.id) : byUpdated;
    });
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
          conflict.columns(["backing_cron_store_key", "routine_id"]).doUpdateSet({
            routine_json: (eb) => eb.ref("excluded.routine_json"),
          }),
        ),
    );
  });
}

function deleteRoutineRecordFromSqlite(id: string, storeKey: string): boolean {
  const routineId = id.trim();
  if (!routineId) {
    return false;
  }
  let deleted = false;
  runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getRoutineStoreKysely(db)
        .deleteFrom("routine_records")
        .where("routine_id", "=", routineId)
        .where("backing_cron_store_key", "=", storeKey),
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
    throw routineInvalidRequest(`${label} is required`);
  }
  return normalized;
}

function normalizeRoutineId(value: string | undefined): string {
  if (value === undefined) {
    return createRoutineId();
  }
  return normalizeExistingRoutineId(value);
}

function normalizeExistingRoutineId(value: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw routineInvalidRequest("routine id must not be blank");
  }
  return normalized;
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

function assertRoutinePayloadNonBlank(payload: CronPayload): void {
  if (payload.kind === "agentTurn" && !normalizeOptionalString(payload.message)) {
    throw routineInvalidRequest("routine agent message must not be blank");
  }
  if (payload.kind === "systemEvent" && !normalizeOptionalString(payload.text)) {
    throw routineInvalidRequest("routine system event text must not be blank");
  }
}

function routineDeliveryHasStableTarget(owner: RoutineOwner, delivery: CronDelivery): boolean {
  return Boolean(owner.sessionKey || normalizeOptionalString(delivery.to));
}

function normalizeRoutineDelivery(
  owner: RoutineOwner,
  delivery: CronDelivery | undefined,
): CronDelivery | undefined {
  if (!delivery) {
    return owner.sessionKey ? undefined : { mode: "none" };
  }
  if (
    (delivery.mode ?? "announce") === "announce" &&
    !routineDeliveryHasStableTarget(owner, delivery)
  ) {
    throw routineInvalidRequest(
      "routine announce delivery requires owner.sessionKey or delivery.to",
    );
  }
  return delivery;
}

function normalizeRoutineCreateInput(input: RoutineCreateInput): NormalizedRoutineCreate {
  const id = normalizeRoutineId(input.id);
  const name = requireNonBlankString(input.name, "routine name");
  const description = normalizeOptionalString(input.description);
  const owner = normalizeRoutineOwner(input);
  const delivery = normalizeRoutineDelivery(owner, input.target?.delivery);
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
      delivery,
    },
    {
      sessionContext: { sessionKey: owner.sessionKey },
    },
  );
  if (!cronInput) {
    throw routineInvalidRequest("invalid routine schedule or action");
  }
  const cronInputWithId = { ...cronInput, id: createRoutineCronJobId(id) };
  assertRoutinePayloadNonBlank(cronInputWithId.payload);
  if (cronInputWithId.sessionTarget === "main" && cronInputWithId.delivery?.mode === "webhook") {
    throw routineInvalidRequest("main-session routines do not support webhook delivery");
  }
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

function hasExplicitEveryAnchor(schedule: CronSchedule): boolean {
  return (
    schedule.kind === "every" &&
    typeof schedule.anchorMs === "number" &&
    Number.isFinite(schedule.anchorMs)
  );
}

function routineIntentSignature(
  record: RoutineRecord,
  opts?: { includeEveryAnchor?: boolean },
): string {
  return stableStringify({
    name: record.name,
    description: record.description,
    owner: record.owner,
    target: routineTargetIntent(record.target),
    trigger: {
      kind: record.trigger.kind,
      schedule: routineScheduleIntent(record.trigger.schedule, opts?.includeEveryAnchor),
    },
    action: record.action,
  });
}

function routineScheduleIntent(schedule: CronSchedule, includeEveryAnchor?: boolean): CronSchedule {
  if (schedule.kind !== "every") {
    return schedule;
  }
  if (includeEveryAnchor === true && hasExplicitEveryAnchor(schedule)) {
    return {
      kind: "every",
      everyMs: schedule.everyMs,
      anchorMs: schedule.anchorMs,
    };
  }
  return {
    kind: "every",
    everyMs: schedule.everyMs,
  };
}

function routineLinkedScheduleForView(
  routineSchedule: CronSchedule,
  cronSchedule: CronSchedule,
): CronSchedule {
  if (
    routineSchedule.kind === "every" &&
    cronSchedule.kind === "every" &&
    !hasExplicitEveryAnchor(routineSchedule)
  ) {
    return routineScheduleIntent(cronSchedule, false);
  }
  return cronSchedule;
}

function routineTargetIntent(target: RoutineTarget): RoutineTarget {
  const delivery = target.delivery;
  if (delivery?.mode !== "announce" || delivery.channel !== undefined) {
    return target;
  }
  return {
    ...target,
    delivery: {
      ...delivery,
      channel: "last",
    },
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function routineIntentSignatureFromNormalized(normalized: NormalizedRoutineCreate): string {
  const cronInput = normalized.cronInput;
  return stableStringify({
    name: normalized.name,
    description: normalized.description,
    owner: {
      ...(cronInput.agentId ? { agentId: cronInput.agentId } : {}),
      ...(cronInput.sessionKey ? { sessionKey: cronInput.sessionKey } : {}),
    },
    target: routineTargetIntent(normalized.target),
    trigger: {
      kind: "schedule",
      schedule: routineScheduleIntent(
        cronInput.schedule,
        hasExplicitEveryAnchor(cronInput.schedule),
      ),
    },
    action: cronInput.payload,
  });
}

function assertNewRoutineScheduleIsValid(schedule: CronSchedule): void {
  const timestampValidation = validateScheduleTimestamp(schedule);
  if (!timestampValidation.ok) {
    throw routineInvalidRequest(timestampValidation.message);
  }
}

function assertRoutineCanBeEnabled(cronJob: CronJob): void {
  if (cronJob.schedule.kind !== "at") {
    return;
  }
  const atMs = parseAbsoluteTimeMs(cronJob.schedule.at);
  if (atMs === null || atMs <= Date.now()) {
    throw routineInvalidRequest(
      `cannot enable expired one-shot routine ${cronJob.id}; create a new routine or reschedule it`,
    );
  }
}

function assertGeneratedEveryAnchorMatchesBaseline(record: RoutineRecord, cronJob: CronJob): void {
  if (
    record.trigger.schedule.kind !== "every" ||
    cronJob.schedule.kind !== "every" ||
    hasExplicitEveryAnchor(record.trigger.schedule)
  ) {
    return;
  }
  const anchorMs = cronJob.schedule.anchorMs;
  if (typeof anchorMs !== "number" || !Number.isFinite(anchorMs)) {
    return;
  }
  if (anchorMs !== cronJob.createdAtMs) {
    throw routineInvalidRequest(
      `routine backing cron job changed generated anchor: ${record.trigger.cronJobId}`,
    );
  }
}

function createRoutineRecord(params: {
  normalized: NormalizedRoutineCreate;
  enabled: boolean;
  cronJobId: string;
  action: CronPayload;
  createdAtMs: number;
  updatedAtMs: number;
  cronStorePath?: string;
}): RoutineRecord {
  const { cronInput, id, name, description, target } = params.normalized;
  return {
    id,
    name,
    ...(description ? { description } : {}),
    enabled: params.enabled,
    owner: {
      ...(cronInput.agentId ? { agentId: cronInput.agentId } : {}),
      ...(cronInput.sessionKey ? { sessionKey: cronInput.sessionKey } : {}),
    },
    target,
    trigger: {
      kind: "schedule",
      schedule: cronInput.schedule,
      cronJobId: params.cronJobId,
      cronStoreKey: routineCronStoreKey(params.cronStorePath),
    },
    action: params.action,
    createdAtMs: params.createdAtMs,
    updatedAtMs: params.updatedAtMs,
  };
}

function createRoutineRecordFromCronJob(record: RoutineRecord, cronJob: CronJob): RoutineRecord {
  const description = normalizeOptionalString(cronJob.description);
  return {
    id: record.id,
    name: cronJob.name,
    ...(description ? { description } : {}),
    enabled: cronJob.enabled,
    owner: {
      ...(cronJob.agentId ? { agentId: cronJob.agentId } : {}),
      ...(cronJob.sessionKey ? { sessionKey: cronJob.sessionKey } : {}),
    },
    target: {
      sessionTarget: cronJob.sessionTarget,
      wakeMode: cronJob.wakeMode,
      ...(cronJob.delivery ? { delivery: cronJob.delivery } : {}),
    },
    trigger: {
      kind: "schedule",
      schedule: routineLinkedScheduleForView(record.trigger.schedule, cronJob.schedule),
      cronJobId: cronJob.id,
      ...(record.trigger.cronStoreKey ? { cronStoreKey: record.trigger.cronStoreKey } : {}),
    },
    action: cronJob.payload,
    createdAtMs: record.createdAtMs,
    updatedAtMs: cronJob.updatedAtMs,
  };
}

async function readCronJobsById(cron: CronServiceContract): Promise<Map<string, CronJob>> {
  const jobs = await cron.list({ includeDisabled: true });
  return new Map(jobs.map((job) => [job.id, job]));
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
    ...(state.lastDelivered !== undefined ? { lastDelivered: state.lastDelivered } : {}),
    ...(state.lastDeliveryStatus ? { lastDeliveryStatus: state.lastDeliveryStatus } : {}),
    ...(state.lastDeliveryError ? { lastDeliveryError: state.lastDeliveryError } : {}),
  };
}

function toRoutineView(record: RoutineRecord, cronJob: CronJob | undefined): RoutineView {
  const status = routineStatus(record, cronJob);
  // Cron is canonical for executable fields while linked. The routine row is a
  // registry snapshot used for missing-backing visibility and create recovery.
  const source = cronJob ? createRoutineRecordFromCronJob(record, cronJob) : record;
  return {
    ...source,
    enabled: status.enabled,
    status,
  };
}

function routineEffectiveAgentId(routine: RoutineView, defaultAgentId: string | undefined): string {
  return sanitizeAgentId(routine.owner.agentId ?? defaultAgentId ?? DEFAULT_AGENT_ID);
}

function routineMatchesListOptions(
  routine: RoutineView,
  options: RoutineListOptions,
  defaultAgentId: string | undefined,
): boolean {
  if (!options.includeDisabled && !routine.status.enabled) {
    return false;
  }
  const rawAgentId = normalizeOptionalString(options.agentId);
  if (
    rawAgentId &&
    routineEffectiveAgentId(routine, defaultAgentId) !== sanitizeAgentId(rawAgentId)
  ) {
    return false;
  }
  const query = normalizeLowercaseStringOrEmpty(options.query);
  if (!query) {
    return true;
  }
  const haystack = normalizeLowercaseStringOrEmpty(
    [
      routine.id,
      routine.name,
      routine.description ?? "",
      routine.owner.agentId ?? "",
      routine.trigger.cronJobId,
    ].join(" "),
  );
  return haystack.includes(query);
}

function assertRoutineCronStoreActive(record: RoutineRecord, cronStorePath: string | undefined) {
  if (
    record.trigger.cronStoreKey &&
    record.trigger.cronStoreKey !== routineCronStoreKey(cronStorePath)
  ) {
    throw routineInvalidRequest(
      `routine backing cron store is not active: ${record.trigger.cronJobId}`,
    );
  }
}

async function removeRoutineBackingCronJob(
  cronJobId: string,
  context: RoutineCronContext,
): Promise<boolean> {
  const result = await context.cron.remove(cronJobId);
  if (!result.ok || !result.removed) {
    throw new Error(`failed to remove routine backing cron job: ${cronJobId}`);
  }
  return true;
}

export async function listRoutines(
  options: RoutineListOptions,
  context: RoutineCronContext,
): Promise<{ routines: RoutineView[] }> {
  const records = listRoutineRecordsFromSqlite(routineCronStoreKey(context.cronStorePath));
  const jobsById = await readCronJobsById(context.cron);
  const views = records.map((record) =>
    toRoutineView(record, jobsById.get(record.trigger.cronJobId)),
  );
  const defaultAgentId = context.cron.getDefaultAgentId();
  const filtered = views.filter((routine) =>
    routineMatchesListOptions(routine, options, defaultAgentId),
  );
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
  const record = getRoutineRecordFromSqlite(id, routineCronStoreKey(context.cronStorePath));
  if (!record) {
    return undefined;
  }
  const cronJob = await context.cron.readJob(record.trigger.cronJobId);
  return toRoutineView(record, cronJob);
}

function assertRoutineBackingCronJobMatches(
  record: RoutineRecord,
  normalized: NormalizedRoutineCreate,
  cronJob: CronJob,
): void {
  if (cronJob.deleteAfterRun !== false) {
    throw routineInvalidRequest(
      `routine backing cron job changed deleteAfterRun: ${record.trigger.cronJobId}`,
    );
  }
  assertGeneratedEveryAnchorMatchesBaseline(record, cronJob);
  const comparable = createRoutineRecordFromCronJob(record, cronJob);
  if (
    routineIntentSignature(comparable, {
      includeEveryAnchor: hasExplicitEveryAnchor(record.trigger.schedule),
    }) !== routineIntentSignatureFromNormalized(normalized)
  ) {
    throw routineInvalidRequest(
      `routine id already exists with different intent: ${normalized.id}`,
    );
  }
}

async function createRoutineBackingCronJob(params: {
  record: RoutineRecord;
  normalized: NormalizedRoutineCreate;
  context: RoutineCronContext;
}): Promise<CronJob> {
  assertRoutineCronStoreActive(params.record, params.context.cronStorePath);
  assertNewRoutineScheduleIsValid(params.normalized.cronInput.schedule);
  try {
    await params.context.validateCronCreate?.(params.normalized.cronInput);
  } catch (err) {
    throw routineInvalidRequest(formatErrorMessage(err), err);
  }
  const added = await params.context.cron.add({
    ...params.normalized.cronInput,
    id: params.record.trigger.cronJobId,
  });
  try {
    assertRoutineBackingCronJobMatches(params.record, params.normalized, added);
  } catch (err) {
    const rollbackError = await removeCreatedRoutineBackingCronJob({
      context: params.context,
      cronJobId: added.id,
      reason: "invalid routine backing cron job",
      cause: err,
    });
    if (rollbackError) {
      throw rollbackError;
    }
    throw err;
  }
  return added;
}

function persistAdoptedRoutineRecord(params: {
  draft: RoutineRecord;
  normalized: NormalizedRoutineCreate;
  cronJob: CronJob;
  cronStorePath?: string;
}): RoutineRecord {
  assertRoutineBackingCronJobMatches(params.draft, params.normalized, params.cronJob);
  const record = createRoutineRecord({
    normalized: params.normalized,
    enabled: params.cronJob.enabled,
    cronJobId: params.cronJob.id,
    action: params.cronJob.payload,
    cronStorePath: params.cronStorePath,
    createdAtMs: params.cronJob.createdAtMs,
    updatedAtMs: params.cronJob.updatedAtMs,
  });
  try {
    upsertRoutineRecordToSqlite(record);
  } catch (err) {
    throw new Error(`failed to persist routine: ${formatErrorMessage(err)}`, { cause: err });
  }
  return record;
}

async function removeCreatedRoutineBackingCronJob(params: {
  context: RoutineCronContext;
  cronJobId: string;
  reason: string;
  cause: unknown;
}): Promise<Error | undefined> {
  try {
    const result = await params.context.cron.remove(params.cronJobId);
    if (result.ok) {
      return undefined;
    }
    return new Error(
      `${params.reason}: ${formatErrorMessage(params.cause)}; failed to roll back backing cron job: ${
        params.cronJobId
      }`,
    );
  } catch (rollbackErr) {
    return new Error(
      `${params.reason}: ${formatErrorMessage(params.cause)}; failed to roll back backing cron job: ${formatErrorMessage(
        rollbackErr,
      )}`,
    );
  }
}

async function routinePersistFailureError(params: {
  context: RoutineCronContext;
  cronJobId: string;
  cause: unknown;
}): Promise<Error> {
  const rollbackError = await removeCreatedRoutineBackingCronJob({
    context: params.context,
    cronJobId: params.cronJobId,
    reason: "failed to persist routine",
    cause: params.cause,
  });
  return (
    rollbackError ?? new Error(`failed to persist routine: ${formatErrorMessage(params.cause)}`)
  );
}

function routineCronStateRollbackPatch(state: CronJobState): Partial<CronJobState> {
  return {
    nextRunAtMs: state.nextRunAtMs,
    runningAtMs: state.runningAtMs,
    lastRunAtMs: state.lastRunAtMs,
    lastRunStatus: state.lastRunStatus,
    lastStatus: state.lastStatus,
    lastError: state.lastError,
    lastDiagnostics: structuredClone(state.lastDiagnostics),
    lastDiagnosticSummary: state.lastDiagnosticSummary,
    lastErrorReason: state.lastErrorReason,
    lastDurationMs: state.lastDurationMs,
    consecutiveErrors: state.consecutiveErrors,
    consecutiveSkipped: state.consecutiveSkipped,
    lastFailureAlertAtMs: state.lastFailureAlertAtMs,
    scheduleErrorCount: state.scheduleErrorCount,
    lastDeliveryStatus: state.lastDeliveryStatus,
    lastDeliveryError: state.lastDeliveryError,
    lastDelivered: state.lastDelivered,
    lastFailureNotificationDelivered: state.lastFailureNotificationDelivered,
    lastFailureNotificationDeliveryStatus: state.lastFailureNotificationDeliveryStatus,
    lastFailureNotificationDeliveryError: state.lastFailureNotificationDeliveryError,
  };
}

async function rollbackRoutineCronJobSnapshot(params: {
  context: RoutineCronContext;
  snapshot: CronJob;
  cause: unknown;
}): Promise<Error | undefined> {
  try {
    const specPatch: CronJobPatch = {
      enabled: params.snapshot.enabled,
      schedule: structuredClone(params.snapshot.schedule),
    };
    await params.context.cron.update(params.snapshot.id, specPatch);
    await params.context.cron.update(params.snapshot.id, {
      state: routineCronStateRollbackPatch(params.snapshot.state),
    });
    return undefined;
  } catch (rollbackErr) {
    return new Error(
      `failed to persist routine: ${formatErrorMessage(params.cause)}; failed to roll back backing cron job state: ${formatErrorMessage(
        rollbackErr,
      )}`,
    );
  }
}

export async function createRoutine(
  input: RoutineCreateInput,
  context: RoutineCronContext,
): Promise<RoutineCreateResult> {
  const normalized = normalizeRoutineCreateInput(input);
  const storeKey = routineCronStoreKey(context.cronStorePath);
  return await withRoutineMutationLock(
    routineMutationLockKey(storeKey, normalized.id),
    async () => {
      const existing = getRoutineRecordFromSqlite(normalized.id, storeKey);
      if (existing) {
        assertRoutineCronStoreActive(existing, context.cronStorePath);
        const existingCronJob = await context.cron.readJob(existing.trigger.cronJobId);
        if (existingCronJob) {
          assertRoutineBackingCronJobMatches(existing, normalized, existingCronJob);
        } else if (
          routineIntentSignature(existing, {
            includeEveryAnchor: hasExplicitEveryAnchor(existing.trigger.schedule),
          }) !== routineIntentSignatureFromNormalized(normalized)
        ) {
          throw routineInvalidRequest(
            `routine id already exists with different intent: ${normalized.id}`,
          );
        }
        if (!existingCronJob) {
          return {
            routine: toRoutineView(existing, undefined),
            created: false,
            idempotent: true,
          };
        }
        const record = createRoutineRecord({
          normalized,
          enabled: existingCronJob.enabled,
          cronJobId: existingCronJob.id,
          action: existingCronJob.payload,
          cronStorePath: context.cronStorePath,
          createdAtMs: existing.createdAtMs,
          updatedAtMs: existingCronJob.updatedAtMs,
        });
        upsertRoutineRecordToSqlite(record);
        return {
          routine: toRoutineView(record, existingCronJob),
          created: false,
          idempotent: true,
        };
      }

      const nowMs = Date.now();
      const draft = createRoutineRecord({
        normalized,
        enabled: normalized.enabled,
        cronJobId: normalized.cronInput.id ?? createRoutineCronJobId(normalized.id),
        action: normalized.cronInput.payload,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        cronStorePath: context.cronStorePath,
      });
      const existingBackingCronJob = await context.cron.readJob(draft.trigger.cronJobId);
      if (existingBackingCronJob) {
        const record = persistAdoptedRoutineRecord({
          draft,
          normalized,
          cronJob: existingBackingCronJob,
          cronStorePath: context.cronStorePath,
        });
        return {
          routine: toRoutineView(record, existingBackingCronJob),
          created: false,
          idempotent: true,
        };
      }
      const cronJob = await createRoutineBackingCronJob({ record: draft, normalized, context });
      const record = createRoutineRecord({
        normalized,
        enabled: cronJob.enabled,
        cronJobId: cronJob.id,
        action: cronJob.payload,
        cronStorePath: context.cronStorePath,
        createdAtMs: draft.createdAtMs,
        updatedAtMs: cronJob.updatedAtMs,
      });
      try {
        upsertRoutineRecordToSqlite(record);
      } catch (err) {
        throw await routinePersistFailureError({
          context,
          cronJobId: cronJob.id,
          cause: err,
        });
      }
      return {
        routine: toRoutineView(record, cronJob),
        created: true,
        idempotent: false,
      };
    },
  );
}

export async function setRoutineEnabled(
  id: string,
  enabled: boolean,
  context: RoutineCronContext,
): Promise<RoutineSetEnabledResult> {
  const routineId = normalizeExistingRoutineId(id);
  const storeKey = routineCronStoreKey(context.cronStorePath);
  return await withRoutineMutationLock(routineMutationLockKey(storeKey, routineId), async () => {
    const record = getRoutineRecordFromSqlite(routineId, storeKey);
    if (!record) {
      throw routineInvalidRequest(`routine not found: ${routineId}`);
    }
    assertRoutineCronStoreActive(record, context.cronStorePath);
    const cronJob = await context.cron.readJob(record.trigger.cronJobId);
    if (!cronJob) {
      if (enabled) {
        throw routineInvalidRequest(
          `routine backing cron job is missing: ${record.trigger.cronJobId}`,
        );
      }
      if (!record.enabled) {
        return {
          routine: toRoutineView(record, undefined),
          changed: false,
        };
      }
      const disabled = { ...record, enabled: false, updatedAtMs: Date.now() };
      upsertRoutineRecordToSqlite(disabled);
      return {
        routine: toRoutineView(disabled, undefined),
        changed: record.enabled,
      };
    }
    if (enabled && !cronJob.enabled) {
      assertRoutineCanBeEnabled(cronJob);
    }
    const changed = record.enabled !== enabled || cronJob.enabled !== enabled;
    if (!changed) {
      return {
        routine: toRoutineView(record, cronJob),
        changed: false,
      };
    }
    const previousCronJob = structuredClone(cronJob);
    if (previousCronJob.enabled !== enabled) {
      await context.cron.update(cronJob.id, { enabled });
    }
    const updatedCronJob = await context.cron.readJob(cronJob.id);
    const updatedRecord = {
      ...record,
      enabled,
      updatedAtMs: Date.now(),
    };
    try {
      upsertRoutineRecordToSqlite(updatedRecord);
    } catch (err) {
      if (previousCronJob.enabled !== enabled) {
        const rollbackError = await rollbackRoutineCronJobSnapshot({
          context,
          snapshot: previousCronJob,
          cause: err,
        });
        if (rollbackError) {
          throw rollbackError;
        }
      }
      throw new Error(`failed to persist routine: ${formatErrorMessage(err)}`, { cause: err });
    }
    return {
      routine: toRoutineView(updatedRecord, updatedCronJob),
      changed,
    };
  });
}

export async function deleteRoutine(
  id: string,
  context: RoutineCronContext,
): Promise<RoutineDeleteResult> {
  const routineId = normalizeExistingRoutineId(id);
  const storeKey = routineCronStoreKey(context.cronStorePath);
  return await withRoutineMutationLock(routineMutationLockKey(storeKey, routineId), async () => {
    const record = getRoutineRecordFromSqlite(routineId, storeKey);
    if (!record) {
      return { id: routineId, deleted: false };
    }
    assertRoutineCronStoreActive(record, context.cronStorePath);
    const cronJob = await context.cron.readJob(record.trigger.cronJobId);
    if (cronJob) {
      await removeRoutineBackingCronJob(record.trigger.cronJobId, context);
    }
    const deleted = deleteRoutineRecordFromSqlite(record.id, storeKey);
    return { id: record.id, deleted };
  });
}
