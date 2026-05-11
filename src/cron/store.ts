import type { Insertable, Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  sqliteBooleanInteger,
  sqliteIntegerBoolean,
  sqliteNullableNumber,
  sqliteNullableText,
} from "../infra/sqlite-row-values.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { tryCronScheduleIdentity } from "./schedule-identity.js";
import type {
  CronDelivery,
  CronFailureAlert,
  CronJob,
  CronPayload,
  CronSchedule,
  CronStoreSnapshot,
} from "./types.js";

type CronJobsTable = OpenClawStateKyselyDatabase["cron_jobs"];
type CronJobsDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;
type CronStoreUpdateDatabase = Pick<OpenClawStateKyselyDatabase, "cron_jobs">;

type CronJobRow = Selectable<CronJobsTable>;

type CronJobStateFields = Pick<
  Insertable<CronJobsTable>,
  | "state_json"
  | "runtime_updated_at_ms"
  | "schedule_identity"
  | "next_run_at_ms"
  | "running_at_ms"
  | "last_run_at_ms"
  | "last_run_status"
  | "last_error"
  | "last_duration_ms"
  | "consecutive_errors"
  | "consecutive_skipped"
  | "schedule_error_count"
  | "last_delivery_status"
  | "last_delivery_error"
  | "last_delivered"
  | "last_failure_alert_at_ms"
>;

export type CronRuntimeStateEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

export type CronRuntimeStateSnapshot = {
  version: 1;
  jobs: Record<string, CronRuntimeStateEntry>;
};

const DEFAULT_CRON_STORE_KEY = "default";

function cronStoreKey(storeKey: string): string {
  const normalized = storeKey.trim();
  return normalized || DEFAULT_CRON_STORE_KEY;
}

function getCronJobsKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<CronJobsDatabase>(db);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stripRuntimeOnlyCronJobFields(job: CronJob): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  return { ...rest, state: {} };
}

export function extractCronRuntimeStateSnapshot(
  store: CronStoreSnapshot,
): CronRuntimeStateSnapshot {
  const jobs: Record<string, CronRuntimeStateEntry> = {};
  for (const job of store.jobs) {
    jobs[job.id] = {
      updatedAtMs: job.updatedAtMs,
      scheduleIdentity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>),
      state: job.state ?? {},
    };
  }
  return { version: 1, jobs };
}

export function resolveCronStoreKey(): string {
  return DEFAULT_CRON_STORE_KEY;
}

function ensureJobStateObject(job: CronStoreSnapshot["jobs"][number]): void {
  if (!job.state || typeof job.state !== "object") {
    job.state = {} as never;
  }
}

function resolveUpdatedAtMs(job: CronStoreSnapshot["jobs"][number], updatedAtMs: unknown): number {
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }
  if (typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)) {
    return job.updatedAtMs;
  }
  return typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
    ? job.createdAtMs
    : Date.now();
}

function mergeRuntimeStateSnapshotEntry(
  job: CronStoreSnapshot["jobs"][number],
  entry: CronRuntimeStateEntry,
): void {
  job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
  job.state = (entry.state ?? {}) as never;
  if (
    typeof entry.scheduleIdentity === "string" &&
    entry.scheduleIdentity !== tryCronScheduleIdentity(job as unknown as Record<string, unknown>)
  ) {
    ensureJobStateObject(job);
    job.state.nextRunAtMs = undefined;
  }
}

function parseCronStateJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assignDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function optionalNumber(value: number | bigint | null): number | undefined {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : undefined;
}

function cronRuntimeStateFromRow(row: CronJobRow): Record<string, unknown> {
  const state = parseCronStateJson(row.state_json);
  assignDefined(state, "nextRunAtMs", optionalNumber(row.next_run_at_ms));
  assignDefined(state, "runningAtMs", optionalNumber(row.running_at_ms));
  assignDefined(state, "lastRunAtMs", optionalNumber(row.last_run_at_ms));
  assignDefined(state, "lastRunStatus", optionalText(row.last_run_status));
  assignDefined(state, "lastError", optionalText(row.last_error));
  assignDefined(state, "lastDurationMs", optionalNumber(row.last_duration_ms));
  assignDefined(state, "consecutiveErrors", optionalNumber(row.consecutive_errors));
  assignDefined(state, "consecutiveSkipped", optionalNumber(row.consecutive_skipped));
  assignDefined(state, "scheduleErrorCount", optionalNumber(row.schedule_error_count));
  assignDefined(state, "lastDeliveryStatus", optionalText(row.last_delivery_status));
  assignDefined(state, "lastDeliveryError", optionalText(row.last_delivery_error));
  assignDefined(state, "lastDelivered", sqliteIntegerBoolean(row.last_delivered));
  assignDefined(state, "lastFailureAlertAtMs", optionalNumber(row.last_failure_alert_at_ms));
  return state;
}

function parseJsonArray(value: string | null): unknown[] | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string | null): string[] | undefined {
  return parseJsonArray(value)?.filter((item): item is string => typeof item === "string");
}

function parseJsonRecord(value: string | null): Record<string, unknown> | undefined {
  if (value == null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function optionalText(value: string | null): string | undefined {
  return value ?? undefined;
}

function optionalBoolean(value: number | null): boolean | undefined {
  return value == null ? undefined : value !== 0;
}

function cronScheduleFromRow(row: CronJobRow): CronSchedule | null {
  switch (row.schedule_kind) {
    case "at":
      return row.at ? { kind: "at", at: row.at } : null;
    case "every":
      return row.every_ms == null
        ? null
        : {
            kind: "every",
            everyMs: row.every_ms,
            ...(row.anchor_ms != null ? { anchorMs: row.anchor_ms } : {}),
          };
    case "cron":
      return row.schedule_expr
        ? {
            kind: "cron",
            expr: row.schedule_expr,
            ...(row.schedule_tz ? { tz: row.schedule_tz } : {}),
            ...(row.stagger_ms != null ? { staggerMs: row.stagger_ms } : {}),
          }
        : null;
    default:
      return null;
  }
}

function cronPayloadFromRow(row: CronJobRow): CronPayload | null {
  switch (row.payload_kind) {
    case "systemEvent":
      return row.payload_message ? { kind: "systemEvent", text: row.payload_message } : null;
    case "agentTurn": {
      if (!row.payload_message) {
        return null;
      }
      const fallbacks = parseStringArray(row.payload_fallbacks_json);
      const externalContentSource = parseJsonRecord(row.payload_external_content_source_json) as
        | HookExternalContentSource
        | undefined;
      const toolsAllow = parseStringArray(row.payload_tools_allow_json);
      return {
        kind: "agentTurn",
        message: row.payload_message,
        ...(row.payload_model ? { model: row.payload_model } : {}),
        ...(fallbacks ? { fallbacks } : {}),
        ...(row.payload_thinking ? { thinking: row.payload_thinking } : {}),
        ...(row.payload_timeout_seconds != null
          ? { timeoutSeconds: row.payload_timeout_seconds }
          : {}),
        ...(row.payload_allow_unsafe_external_content != null
          ? { allowUnsafeExternalContent: row.payload_allow_unsafe_external_content !== 0 }
          : {}),
        ...(externalContentSource ? { externalContentSource } : {}),
        ...(row.payload_light_context != null
          ? { lightContext: row.payload_light_context !== 0 }
          : {}),
        ...(toolsAllow ? { toolsAllow } : {}),
      };
    }
    default:
      return null;
  }
}

function cronDeliveryFromRow(row: CronJobRow): CronDelivery | undefined {
  if (
    !row.delivery_mode &&
    !row.delivery_channel &&
    !row.delivery_to &&
    !row.delivery_thread_id &&
    !row.delivery_account_id &&
    row.delivery_best_effort == null &&
    !row.failure_delivery_mode &&
    !row.failure_delivery_channel &&
    !row.failure_delivery_to &&
    !row.failure_delivery_account_id
  ) {
    return undefined;
  }
  const failureDestination =
    row.failure_delivery_mode ||
    row.failure_delivery_channel ||
    row.failure_delivery_to ||
    row.failure_delivery_account_id
      ? {
          ...(row.failure_delivery_mode ? { mode: row.failure_delivery_mode } : {}),
          ...(row.failure_delivery_channel ? { channel: row.failure_delivery_channel } : {}),
          ...(row.failure_delivery_to ? { to: row.failure_delivery_to } : {}),
          ...(row.failure_delivery_account_id
            ? { accountId: row.failure_delivery_account_id }
            : {}),
        }
      : undefined;
  return {
    mode: row.delivery_mode ?? "announce",
    ...(row.delivery_channel ? { channel: row.delivery_channel } : {}),
    ...(row.delivery_to ? { to: row.delivery_to } : {}),
    ...(row.delivery_thread_id ? { threadId: row.delivery_thread_id } : {}),
    ...(row.delivery_account_id ? { accountId: row.delivery_account_id } : {}),
    ...(row.delivery_best_effort != null ? { bestEffort: row.delivery_best_effort !== 0 } : {}),
    ...(failureDestination ? { failureDestination } : {}),
  } as CronDelivery;
}

function cronFailureAlertFromRow(row: CronJobRow): CronFailureAlert | false | undefined {
  if (row.failure_alert_disabled) {
    return false;
  }
  if (
    row.failure_alert_after == null &&
    !row.failure_alert_channel &&
    !row.failure_alert_to &&
    row.failure_alert_cooldown_ms == null &&
    row.failure_alert_include_skipped == null &&
    !row.failure_alert_mode &&
    !row.failure_alert_account_id
  ) {
    return undefined;
  }
  return {
    ...(row.failure_alert_after != null ? { after: row.failure_alert_after } : {}),
    ...(row.failure_alert_channel ? { channel: row.failure_alert_channel } : {}),
    ...(row.failure_alert_to ? { to: row.failure_alert_to } : {}),
    ...(row.failure_alert_cooldown_ms != null ? { cooldownMs: row.failure_alert_cooldown_ms } : {}),
    ...(row.failure_alert_include_skipped != null
      ? { includeSkipped: row.failure_alert_include_skipped !== 0 }
      : {}),
    ...(row.failure_alert_mode ? { mode: row.failure_alert_mode } : {}),
    ...(row.failure_alert_account_id ? { accountId: row.failure_alert_account_id } : {}),
  } as CronFailureAlert;
}

function cronJobFromRow(row: CronJobRow): CronJob | null {
  const schedule = cronScheduleFromRow(row);
  const payload = cronPayloadFromRow(row);
  if (!schedule || !payload) {
    return null;
  }
  const delivery = cronDeliveryFromRow(row);
  const failureAlert = cronFailureAlertFromRow(row);
  const job: CronJob = {
    id: row.job_id,
    name: row.name,
    enabled: row.enabled !== 0,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.runtime_updated_at_ms ?? row.updated_at,
    schedule,
    sessionTarget: row.session_target as CronJob["sessionTarget"],
    wakeMode: row.wake_mode as CronJob["wakeMode"],
    payload,
    state: {},
    ...(optionalText(row.description) ? { description: optionalText(row.description) } : {}),
    ...(optionalBoolean(row.delete_after_run) !== undefined
      ? { deleteAfterRun: optionalBoolean(row.delete_after_run) }
      : {}),
    ...(optionalText(row.agent_id) ? { agentId: optionalText(row.agent_id) } : {}),
    ...(optionalText(row.session_key) ? { sessionKey: optionalText(row.session_key) } : {}),
    ...(delivery ? { delivery } : {}),
    ...(failureAlert !== undefined ? { failureAlert } : {}),
  };
  mergeCronJobRowRuntimeState(job, row);
  ensureJobStateObject(job);
  return job;
}

function mergeCronJobRowRuntimeState(
  job: CronStoreSnapshot["jobs"][number],
  row: CronJobRow,
): void {
  mergeRuntimeStateSnapshotEntry(job, {
    updatedAtMs: row.runtime_updated_at_ms ?? undefined,
    scheduleIdentity: row.schedule_identity ?? undefined,
    state: cronRuntimeStateFromRow(row),
  });
}

function hydrateCronStoreFromSqlite(storeKey: string): CronStoreSnapshot {
  const database = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    database.db,
    getCronJobsKysely(database.db)
      .selectFrom("cron_jobs")
      .selectAll()
      .where("store_key", "=", cronStoreKey(storeKey))
      .orderBy("sort_order", "asc")
      .orderBy("updated_at", "asc")
      .orderBy("job_id", "asc"),
  ).rows;
  const jobs = rows.flatMap((row) => {
    const job = cronJobFromRow(row);
    return job ? [job] : [];
  });
  return { version: 1, jobs };
}

export async function loadCronStore(storeKey: string): Promise<CronStoreSnapshot> {
  return hydrateCronStoreFromSqlite(storeKey);
}

export function loadCronStoreSync(storeKey: string): CronStoreSnapshot {
  return hydrateCronStoreFromSqlite(storeKey);
}

function cronJobStateFields(job: CronJob): CronJobStateFields {
  const state = job.state ?? {};
  return {
    state_json: JSON.stringify(state),
    runtime_updated_at_ms: sqliteNullableNumber(job.updatedAtMs),
    schedule_identity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>),
    next_run_at_ms: sqliteNullableNumber(state.nextRunAtMs),
    running_at_ms: sqliteNullableNumber(state.runningAtMs),
    last_run_at_ms: sqliteNullableNumber(state.lastRunAtMs),
    last_run_status: sqliteNullableText(state.lastRunStatus ?? state.lastStatus),
    last_error: sqliteNullableText(state.lastError),
    last_duration_ms: sqliteNullableNumber(state.lastDurationMs),
    consecutive_errors: sqliteNullableNumber(state.consecutiveErrors),
    consecutive_skipped: sqliteNullableNumber(state.consecutiveSkipped),
    schedule_error_count: sqliteNullableNumber(state.scheduleErrorCount),
    last_delivery_status: sqliteNullableText(state.lastDeliveryStatus),
    last_delivery_error: sqliteNullableText(state.lastDeliveryError),
    last_delivered: sqliteBooleanInteger(state.lastDelivered),
    last_failure_alert_at_ms: sqliteNullableNumber(state.lastFailureAlertAtMs),
  };
}

function cronJobRow(storeKey: string, job: CronJob, sortOrder: number): Insertable<CronJobsTable> {
  const schedule = job.schedule;
  const failureAlert =
    job.failureAlert === false || job.failureAlert == null ? null : job.failureAlert;
  return {
    store_key: cronStoreKey(storeKey),
    job_id: job.id,
    name: job.name,
    description: sqliteNullableText(job.description),
    enabled: job.enabled ? 1 : 0,
    delete_after_run: sqliteBooleanInteger(job.deleteAfterRun),
    created_at_ms: job.createdAtMs,
    agent_id: sqliteNullableText(job.agentId),
    session_key: sqliteNullableText(job.sessionKey),
    schedule_kind: schedule.kind,
    schedule_expr: schedule.kind === "cron" ? schedule.expr : null,
    schedule_tz: schedule.kind === "cron" ? sqliteNullableText(schedule.tz) : null,
    every_ms: schedule.kind === "every" ? sqliteNullableNumber(schedule.everyMs) : null,
    anchor_ms: schedule.kind === "every" ? sqliteNullableNumber(schedule.anchorMs) : null,
    at: schedule.kind === "at" ? schedule.at : null,
    stagger_ms: schedule.kind === "cron" ? sqliteNullableNumber(schedule.staggerMs) : null,
    session_target: job.sessionTarget,
    wake_mode: job.wakeMode,
    payload_kind: job.payload.kind,
    payload_message: job.payload.kind === "systemEvent" ? job.payload.text : job.payload.message,
    payload_model: job.payload.kind === "agentTurn" ? sqliteNullableText(job.payload.model) : null,
    payload_fallbacks_json:
      job.payload.kind === "agentTurn" && job.payload.fallbacks
        ? JSON.stringify(job.payload.fallbacks)
        : null,
    payload_thinking:
      job.payload.kind === "agentTurn" ? sqliteNullableText(job.payload.thinking) : null,
    payload_timeout_seconds:
      job.payload.kind === "agentTurn" ? sqliteNullableNumber(job.payload.timeoutSeconds) : null,
    payload_allow_unsafe_external_content:
      job.payload.kind === "agentTurn"
        ? sqliteBooleanInteger(job.payload.allowUnsafeExternalContent)
        : null,
    payload_external_content_source_json:
      job.payload.kind === "agentTurn" && job.payload.externalContentSource
        ? JSON.stringify(job.payload.externalContentSource)
        : null,
    payload_light_context:
      job.payload.kind === "agentTurn" ? sqliteBooleanInteger(job.payload.lightContext) : null,
    payload_tools_allow_json:
      job.payload.kind === "agentTurn" && job.payload.toolsAllow
        ? JSON.stringify(job.payload.toolsAllow)
        : null,
    delivery_mode: sqliteNullableText(job.delivery?.mode),
    delivery_channel: sqliteNullableText(job.delivery?.channel),
    delivery_to: sqliteNullableText(job.delivery?.to),
    delivery_thread_id:
      job.delivery?.threadId == null ? null : sqliteNullableText(String(job.delivery.threadId)),
    delivery_account_id: sqliteNullableText(job.delivery?.accountId),
    delivery_best_effort: sqliteBooleanInteger(job.delivery?.bestEffort),
    failure_delivery_mode: sqliteNullableText(job.delivery?.failureDestination?.mode),
    failure_delivery_channel: sqliteNullableText(job.delivery?.failureDestination?.channel),
    failure_delivery_to: sqliteNullableText(job.delivery?.failureDestination?.to),
    failure_delivery_account_id: sqliteNullableText(job.delivery?.failureDestination?.accountId),
    failure_alert_disabled: job.failureAlert === false ? 1 : null,
    failure_alert_after: failureAlert ? sqliteNullableNumber(failureAlert.after) : null,
    failure_alert_channel: failureAlert ? sqliteNullableText(failureAlert.channel) : null,
    failure_alert_to: failureAlert ? sqliteNullableText(failureAlert.to) : null,
    failure_alert_cooldown_ms: failureAlert ? sqliteNullableNumber(failureAlert.cooldownMs) : null,
    failure_alert_include_skipped: failureAlert
      ? sqliteBooleanInteger(failureAlert.includeSkipped)
      : null,
    failure_alert_mode: failureAlert ? sqliteNullableText(failureAlert.mode) : null,
    failure_alert_account_id: failureAlert ? sqliteNullableText(failureAlert.accountId) : null,
    job_json: JSON.stringify(stripRuntimeOnlyCronJobFields(job)),
    ...cronJobStateFields(job),
    sort_order: sortOrder,
    updated_at: Date.now(),
  };
}

function upsertCronJobRow(params: {
  db: ReturnType<typeof getCronJobsKysely>;
  sqlite: import("node:sqlite").DatabaseSync;
  row: Insertable<CronJobsTable>;
}): void {
  const { store_key: _storeKey, job_id: _jobId, ...updates } = params.row;
  executeSqliteQuerySync(
    params.sqlite,
    params.db
      .insertInto("cron_jobs")
      .values(params.row)
      .onConflict((conflict) => conflict.columns(["store_key", "job_id"]).doUpdateSet(updates)),
  );
}

function writeCronJobsToSqlite(storeKey: string, store: CronStoreSnapshot): void {
  const normalizedStoreKey = cronStoreKey(storeKey);
  runOpenClawStateWriteTransaction((database) => {
    const db = getCronJobsKysely(database.db);
    const existingRows = executeSqliteQuerySync(
      database.db,
      db.selectFrom("cron_jobs").select("job_id").where("store_key", "=", normalizedStoreKey),
    ).rows;
    const nextJobIds = new Set(store.jobs.map((job) => job.id));
    for (const [index, job] of store.jobs.entries()) {
      upsertCronJobRow({ db, sqlite: database.db, row: cronJobRow(storeKey, job, index) });
    }
    for (const row of existingRows) {
      if (nextJobIds.has(row.job_id)) {
        continue;
      }
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("cron_jobs")
          .where("store_key", "=", normalizedStoreKey)
          .where("job_id", "=", row.job_id),
      );
    }
  });
}

export function writeCronRuntimeStateSnapshot(
  storeKey: string,
  stateSnapshot: CronRuntimeStateSnapshot,
): number {
  const normalizedStoreKey = cronStoreKey(storeKey);
  const updatedAt = Date.now();
  let importedJobs = 0;
  runOpenClawStateWriteTransaction((database) => {
    const db = getCronJobsKysely(database.db);
    for (const [jobId, entry] of Object.entries(stateSnapshot.jobs)) {
      const result = executeSqliteQuerySync(
        database.db,
        db
          .updateTable("cron_jobs")
          .set({
            state_json: JSON.stringify(entry.state ?? {}),
            runtime_updated_at_ms:
              typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)
                ? entry.updatedAtMs
                : null,
            schedule_identity:
              typeof entry.scheduleIdentity === "string" ? entry.scheduleIdentity : null,
            next_run_at_ms: sqliteNullableNumber(entry.state?.nextRunAtMs),
            running_at_ms: sqliteNullableNumber(entry.state?.runningAtMs),
            last_run_at_ms: sqliteNullableNumber(entry.state?.lastRunAtMs),
            last_run_status: sqliteNullableText(
              entry.state?.lastRunStatus ?? entry.state?.lastStatus,
            ),
            last_error: sqliteNullableText(entry.state?.lastError),
            last_duration_ms: sqliteNullableNumber(entry.state?.lastDurationMs),
            consecutive_errors: sqliteNullableNumber(entry.state?.consecutiveErrors),
            consecutive_skipped: sqliteNullableNumber(entry.state?.consecutiveSkipped),
            schedule_error_count: sqliteNullableNumber(entry.state?.scheduleErrorCount),
            last_delivery_status: sqliteNullableText(entry.state?.lastDeliveryStatus),
            last_delivery_error: sqliteNullableText(entry.state?.lastDeliveryError),
            last_delivered: sqliteBooleanInteger(entry.state?.lastDelivered),
            last_failure_alert_at_ms: sqliteNullableNumber(entry.state?.lastFailureAlertAtMs),
            updated_at: updatedAt,
          })
          .where("store_key", "=", normalizedStoreKey)
          .where("job_id", "=", jobId),
      );
      if ((result.numAffectedRows ?? 0n) > 0n) {
        importedJobs += 1;
      }
    }
  });
  return importedJobs;
}

export async function saveCronStore(
  storeKey: string,
  store: CronStoreSnapshot,
  opts?: { skipBackup?: boolean; stateOnly?: boolean },
) {
  void opts?.skipBackup;
  if (opts?.stateOnly === true) {
    writeCronRuntimeStateSnapshot(storeKey, extractCronRuntimeStateSnapshot(store));
    return;
  }
  writeCronJobsToSqlite(storeKey, store);
}

export async function updateCronStoreJobs(
  storeKey: string,
  updateJob: (job: CronJob) => CronJob | undefined,
): Promise<{ updatedJobs: number }> {
  const store = await loadCronStore(storeKey);
  const updates: Array<{ previousJobId: string; job: CronJob; sortOrder: number }> = [];

  for (const [index, job] of store.jobs.entries()) {
    const nextJob = updateJob(structuredClone(job));
    if (!nextJob) {
      continue;
    }
    ensureJobStateObject(nextJob);
    updates.push({ previousJobId: job.id, job: nextJob, sortOrder: index });
  }

  if (updates.length === 0) {
    return { updatedJobs: 0 };
  }

  const normalizedStoreKey = cronStoreKey(storeKey);
  const updatedAt = Date.now();
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<CronStoreUpdateDatabase>(database.db);
    for (const update of updates) {
      if (update.previousJobId !== update.job.id) {
        executeSqliteQuerySync(
          database.db,
          db
            .deleteFrom("cron_jobs")
            .where("store_key", "=", normalizedStoreKey)
            .where("job_id", "=", update.previousJobId),
        );
      }
      const row = { ...cronJobRow(storeKey, update.job, update.sortOrder), updated_at: updatedAt };
      upsertCronJobRow({ db, sqlite: database.db, row });
    }
  });

  return { updatedJobs: updates.length };
}
