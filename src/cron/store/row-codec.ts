/** Converts cron jobs between public store shape and normalized SQLite rows. */
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "../legacy-default-agent-owner-records.js";
import { normalizeCronJobIdentityFields } from "../normalize-job-identity.js";
import { normalizeCronJobInput } from "../normalize.js";
import {
  getInvalidPersistedCronJobOwnerReason,
  getInvalidPersistedCronJobReason,
} from "../persisted-shape.js";
import { tryCronScheduleIdentity } from "../schedule-identity.js";
import { normalizeCronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import type { CronJob, CronJobState, CronPacing, CronSchedule, CronStoreFile } from "../types.js";
import { bindDeliveryColumns, deliveryFromRow } from "./delivery-codec.js";
import { bindFailureAlertColumns, failureAlertFromRow } from "./failure-alert-codec.js";
import { bindPayloadColumns, payloadFromRow } from "./payload-codec.js";
import {
  CronRuntimeRevisionMismatchError,
  CronStoreEpochMismatchError,
  CronStoreTopologyMismatchError,
  incrementCronRuntimeRevision,
  incrementCronStoreEpoch,
  readCronRuntimeRevision,
  readCronStoreEpoch,
  writeCronStoreEpoch,
} from "./row-revisions.js";
import { cronRowTopologyFingerprint, cronStoreTopologyMatches } from "./row-topology.js";
import { preserveConcurrentCronRuntime } from "./runtime-merge.js";
import { writeCronRuntimeRowDeltas } from "./runtime-row-writes.js";
import {
  booleanToInteger,
  integerToBoolean,
  normalizeNumber,
  parseJsonObject,
} from "./scalar-codec.js";
import type { CronJobInsert, CronJobRow } from "./schema.js";
import { ensureCronStoreEpochSchema, getCronStoreKysely } from "./schema.js";
import { bindStateColumns, stateFromRow } from "./state-codec.js";
import { bindTriggerColumns, triggerFromRow } from "./trigger-codec.js";
import type { LoadedCronStore } from "./types.js";

export {
  CronRuntimeRevisionMismatchError,
  CronStoreEpochMismatchError,
  CronStoreTopologyMismatchError,
  incrementCronStoreEpoch,
  readCronRuntimeRevision,
  readCronStoreEpoch,
} from "./row-revisions.js";

function bindScheduleColumns(
  schedule: CronSchedule,
): Pick<
  CronJobInsert,
  "anchor_ms" | "at" | "every_ms" | "schedule_expr" | "schedule_kind" | "schedule_tz" | "stagger_ms"
> {
  if (schedule.kind === "at") {
    return {
      schedule_kind: "at",
      at: schedule.at,
      every_ms: null,
      anchor_ms: null,
      schedule_expr: null,
      schedule_tz: null,
      stagger_ms: null,
    };
  }
  if (schedule.kind === "every") {
    return {
      schedule_kind: "every",
      at: null,
      every_ms: schedule.everyMs,
      anchor_ms: schedule.anchorMs ?? null,
      schedule_expr: null,
      schedule_tz: null,
      stagger_ms: null,
    };
  }
  if (schedule.kind === "on-exit") {
    // v1: reuse existing nullable TEXT columns to round-trip the watcher's
    // command (schedule_expr) and cwd (schedule_tz) without a schema migration.
    // schedule_kind disambiguates from cron. (Dedicated columns are a possible
    // follow-up if reviewers prefer.)
    return {
      schedule_kind: "on-exit",
      at: null,
      every_ms: null,
      anchor_ms: null,
      schedule_expr: schedule.command,
      schedule_tz: schedule.cwd ?? null,
      stagger_ms: null,
    };
  }
  if (schedule.kind === "stream") {
    // argv-shaped stream schedules live in the existing additive job_json
    // envelope; normalized columns retain only the discriminant (no DDL).
    return {
      schedule_kind: "stream",
      at: null,
      every_ms: null,
      anchor_ms: null,
      schedule_expr: null,
      schedule_tz: null,
      stagger_ms: null,
    };
  }
  return {
    schedule_kind: "cron",
    at: null,
    every_ms: null,
    anchor_ms: null,
    schedule_expr: schedule.expr,
    schedule_tz: schedule.tz ?? null,
    stagger_ms: schedule.staggerMs ?? null,
  };
}

function stripJobRuntimeFields(job: CronStoreFile["jobs"][number]): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  // job_json stores config shape only; runtime state lives in split columns and
  // state_json so state-only writes never rewrite public job config.
  return { ...rest, state: {} };
}

function mergeFailureDestinationProjection(
  configJob: Record<string, unknown>,
  projectedJob: CronJob | null,
): Record<string, unknown> {
  const failureDestination = projectedJob?.delivery?.failureDestination;
  if (!failureDestination) {
    return configJob;
  }
  // Empty SQLite sentinels preserve explicit undefined fields for failure
  // destination overrides; project them back into the config sidecar shape.
  const delivery: Record<string, unknown> =
    isRecord(configJob.delivery) && !Array.isArray(configJob.delivery)
      ? { ...configJob.delivery }
      : projectedJob?.delivery
        ? {
            mode: projectedJob.delivery.mode,
            ...(projectedJob.delivery.channel ? { channel: projectedJob.delivery.channel } : {}),
            ...(projectedJob.delivery.to ? { to: projectedJob.delivery.to } : {}),
            ...(projectedJob.delivery.threadId !== undefined
              ? { threadId: projectedJob.delivery.threadId }
              : {}),
            ...(projectedJob.delivery.accountId
              ? { accountId: projectedJob.delivery.accountId }
              : {}),
            ...(projectedJob.delivery.bestEffort !== undefined
              ? { bestEffort: projectedJob.delivery.bestEffort }
              : {}),
            ...(projectedJob.delivery.completionDestination
              ? { completionDestination: projectedJob.delivery.completionDestination }
              : {}),
          }
        : {};
  const nextFailureDestination = isRecord(delivery.failureDestination)
    ? { ...delivery.failureDestination }
    : {};
  if (Object.hasOwn(failureDestination, "channel")) {
    nextFailureDestination.channel = failureDestination.channel;
  }
  if (Object.hasOwn(failureDestination, "to")) {
    nextFailureDestination.to = failureDestination.to;
  }
  if (Object.hasOwn(failureDestination, "accountId")) {
    nextFailureDestination.accountId = failureDestination.accountId;
  }
  if (Object.hasOwn(failureDestination, "mode")) {
    nextFailureDestination.mode = failureDestination.mode;
  }
  delivery.failureDestination = nextFailureDestination;
  return {
    ...configJob,
    delivery,
  };
}

function bindCronJobRow(storeKey: string, job: CronJob, sortOrder: number): CronJobInsert {
  return {
    store_key: storeKey,
    job_id: job.id,
    declaration_key: job.declarationKey ?? null,
    display_name: job.displayName ?? null,
    owner_agent_id: job.owner?.agentId ?? null,
    owner_session_key: job.owner?.sessionKey ?? null,
    name: job.name,
    description: job.description ?? null,
    enabled: job.enabled ? 1 : 0,
    delete_after_run: booleanToInteger(job.deleteAfterRun),
    created_at_ms: job.createdAtMs,
    updated_at: job.updatedAtMs,
    agent_id: job.agentId ?? null,
    session_key: job.sessionKey ?? null,
    session_target: job.sessionTarget,
    wake_mode: job.wakeMode,
    ...bindTriggerColumns(job.trigger),
    ...bindScheduleColumns(job.schedule),
    ...bindPayloadColumns(job.payload),
    ...bindDeliveryColumns(job.delivery),
    ...bindFailureAlertColumns(job.failureAlert),
    ...bindStateColumns(job.state ?? {}),
    job_json: JSON.stringify(stripJobRuntimeFields(job)),
    state_json: JSON.stringify(job.state ?? {}),
    runtime_updated_at_ms: job.updatedAtMs,
    schedule_identity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>) ?? null,
    sort_order: sortOrder,
  };
}

function normalizeCronJobForSqlite(job: CronStoreFile["jobs"][number]): CronJob | null {
  const raw = structuredClone(job) as unknown as Record<string, unknown>;
  if (getInvalidPersistedCronJobOwnerReason(raw)) {
    return null;
  }
  const hadDeleteAfterRun = Object.hasOwn(raw, "deleteAfterRun");
  normalizeCronJobIdentityFields(raw);
  const normalized = normalizeCronJobInput(raw, { applyDefaults: true });
  if (!normalized || getInvalidPersistedCronJobReason(normalized)) {
    return null;
  }
  if (!hadDeleteAfterRun) {
    // Legacy rows omitted deleteAfterRun entirely; avoid writing the default
    // back into job_json so config round-trips stay byte-light.
    delete normalized.deleteAfterRun;
  }
  const createdAtMs =
    typeof normalized.createdAtMs === "number" && Number.isFinite(normalized.createdAtMs)
      ? normalized.createdAtMs
      : Date.now();
  const updatedAtMs =
    typeof normalized.updatedAtMs === "number" && Number.isFinite(normalized.updatedAtMs)
      ? normalized.updatedAtMs
      : createdAtMs;
  return {
    ...normalized,
    createdAtMs,
    updatedAtMs,
    state: isRecord(normalized.state) ? (normalized.state as CronJobState) : {},
  } as CronJob;
}

function countUnpersistableCronJobs(store: CronStoreFile): number {
  return store.jobs.reduce((count, job) => count + (normalizeCronJobForSqlite(job) ? 0 : 1), 0);
}

/** Fails before replacing SQLite rows when any config job cannot round-trip. */
export function assertCronStoreCanPersist(store: CronStoreFile): void {
  const invalidJobs = countUnpersistableCronJobs(store);
  if (invalidJobs > 0) {
    throw new Error(`Cannot persist cron store with ${invalidJobs} invalid job(s)`);
  }
}

function scheduleFromRow(row: CronJobRow): CronSchedule | null {
  if (row.schedule_kind === "at" && row.at) {
    return { kind: "at", at: row.at };
  }
  if (row.schedule_kind === "every" && row.every_ms != null) {
    return {
      kind: "every",
      everyMs: normalizeNumber(row.every_ms) ?? 0,
      ...(row.anchor_ms != null ? { anchorMs: normalizeNumber(row.anchor_ms) } : {}),
    };
  }
  if (row.schedule_kind === "cron" && row.schedule_expr) {
    return {
      kind: "cron",
      expr: row.schedule_expr,
      ...(row.schedule_tz ? { tz: row.schedule_tz } : {}),
      ...(row.stagger_ms != null ? { staggerMs: normalizeNumber(row.stagger_ms) } : {}),
    };
  }
  if (row.schedule_kind === "on-exit" && row.schedule_expr) {
    return {
      kind: "on-exit",
      command: row.schedule_expr,
      ...(row.schedule_tz ? { cwd: row.schedule_tz } : {}),
    };
  }
  if (row.schedule_kind === "stream") {
    const schedule = parseJsonObject<Record<string, unknown>>(row.job_json, {}).schedule;
    if (!isRecord(schedule) || schedule.kind !== "stream" || !Array.isArray(schedule.command)) {
      return null;
    }
    return structuredClone(schedule) as CronSchedule;
  }
  return null;
}

function pacingFromRow(row: CronJobRow): CronPacing | undefined {
  const pacing = parseJsonObject<Record<string, unknown>>(row.job_json, {}).pacing;
  if (!isRecord(pacing) || Array.isArray(pacing)) {
    return undefined;
  }
  return {
    ...(typeof pacing.min === "string" ? { min: pacing.min } : {}),
    ...(typeof pacing.max === "string" ? { max: pacing.max } : {}),
  };
}

function rowToCronJob(row: CronJobRow): CronJob | null {
  const jobJson = parseJsonObject<Record<string, unknown>>(row.job_json, {});
  const rawAgentId =
    row.agent_id !== null
      ? row.agent_id
      : Object.hasOwn(jobJson, "agentId")
        ? jobJson.agentId
        : undefined;
  const jsonOwner = isRecord(jobJson.owner) ? jobJson.owner : undefined;
  const ownerAccountId = normalizeOptionalAccountId(
    typeof jsonOwner?.accountId === "string" ? jsonOwner.accountId : undefined,
  );
  const schedule = scheduleFromRow(row);
  const payload = payloadFromRow(row);
  const delivery = deliveryFromRow(row);
  const failureAlert = failureAlertFromRow(row);
  const trigger = triggerFromRow(row);
  const pacing = pacingFromRow(row);
  const scheduledToolPolicy = normalizeCronScheduledToolPolicy(jobJson.scheduledToolPolicy);
  if (!schedule || !payload) {
    return null;
  }
  const createdAtMs = normalizeNumber(row.created_at_ms) ?? Date.now();
  return {
    id: row.job_id,
    ...(row.declaration_key ? { declarationKey: row.declaration_key } : {}),
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.owner_agent_id || row.owner_session_key || ownerAccountId
      ? {
          owner: {
            ...(row.owner_agent_id ? { agentId: row.owner_agent_id } : {}),
            ...(row.owner_session_key ? { sessionKey: row.owner_session_key } : {}),
            ...(ownerAccountId ? { accountId: ownerAccountId } : {}),
          },
        }
      : {}),
    ...(scheduledToolPolicy ? { scheduledToolPolicy } : {}),
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    enabled: row.enabled !== 0,
    ...(row.delete_after_run != null
      ? { deleteAfterRun: integerToBoolean(row.delete_after_run) }
      : {}),
    createdAtMs,
    updatedAtMs:
      normalizeNumber(row.runtime_updated_at_ms) ?? normalizeNumber(row.updated_at) ?? createdAtMs,
    // Preserve malformed explicit sidecar ownership for doctor/adoption validation.
    ...(rawAgentId !== undefined ? { agentId: rawAgentId as string } : {}),
    ...(row.session_key ? { sessionKey: row.session_key } : {}),
    schedule,
    ...(pacing !== undefined ? { pacing } : {}),
    sessionTarget: row.session_target as CronJob["sessionTarget"],
    wakeMode: row.wake_mode as CronJob["wakeMode"],
    ...(trigger ? { trigger } : {}),
    payload,
    ...(delivery ? { delivery } : {}),
    ...(failureAlert !== undefined ? { failureAlert } : {}),
    state: stateFromRow(row),
  };
}

/** Projects a live job through the same normalization/codecs used by SQLite persistence. */
export function projectCronJobThroughStorageCodec(job: CronJob): CronJob {
  const normalized = normalizeCronJobForSqlite(job);
  if (!normalized) {
    throw new Error(`cannot project invalid cron job ${job.id}`);
  }
  const row = bindCronJobRow("config-revision", normalized, 0) as CronJobRow;
  const projected = rowToCronJob(row);
  if (!projected) {
    throw new Error(`cannot project cron job ${job.id} through storage codecs`);
  }
  return projected;
}

/** Loads cron rows in config order with deterministic fallbacks for old rows. */
export function loadCronRows(db: DatabaseSync, storeKey: string): CronJobRow[] {
  return executeSqliteQuerySync(
    db,
    getCronStoreKysely(db)
      .selectFrom("cron_jobs")
      .selectAll()
      .where("store_key", "=", storeKey)
      .orderBy("sort_order", "asc")
      .orderBy("updated_at", "asc")
      .orderBy("job_id", "asc"),
  ).rows;
}

/** Loads cron topology and its stale-writer epoch from one SQLite snapshot. */
export function loadCronRowsWithEpoch(
  db: DatabaseSync,
  storeKey: string,
  options?: { ensureEpochSchema?: boolean; epochSchemaPresent?: boolean },
): { rows: CronJobRow[]; storeEpoch: number; runtimeRevision: number } {
  if (options?.ensureEpochSchema !== false) {
    ensureCronStoreEpochSchema(db);
  }
  return runSqliteDeferredTransactionSync(db, () => ({
    rows: loadCronRows(db, storeKey),
    storeEpoch:
      options?.epochSchemaPresent === false
        ? 0
        : readCronStoreEpoch(db, storeKey, { ensureSchema: false }),
    runtimeRevision:
      options?.epochSchemaPresent === false
        ? 0
        : readCronRuntimeRevision(db, storeKey, { ensureSchema: false }),
  }));
}

/** Materializes retired default ownership without rewriting unrelated cron row fields.
 * The caller owns the shared-state write transaction so row and epoch updates commit together. */
export function materializeCronRowAgentOwners(
  db: DatabaseSync,
  storeKey: string,
  legacyDefaultAgentId: string,
  options?: { jobIds?: ReadonlySet<string> },
): number {
  let rewritten = 0;
  for (const row of loadCronRows(db, storeKey)) {
    if (options?.jobIds && !options.jobIds.has(row.job_id)) {
      continue;
    }
    const jobJson = parseJsonObject<Record<string, unknown>>(row.job_json, {});
    const owner = {
      ...(row.agent_id !== null
        ? { agentId: row.agent_id }
        : Object.hasOwn(jobJson, "agentId")
          ? { agentId: jobJson.agentId }
          : {}),
      ...(row.session_key === null ? {} : { sessionKey: row.session_key }),
    };
    if (
      materializeLegacyDefaultCronJobOwnersInRecords([owner], legacyDefaultAgentId) === 0 ||
      typeof owner.agentId !== "string"
    ) {
      continue;
    }
    jobJson.agentId = owner.agentId;
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .updateTable("cron_jobs")
        .set({ agent_id: owner.agentId, job_json: JSON.stringify(jobJson) })
        .where("store_key", "=", storeKey)
        .where("job_id", "=", row.job_id),
    );
    rewritten += 1;
  }
  if (rewritten > 0) {
    incrementCronStoreEpoch(db, storeKey);
  }
  return rewritten;
}

/** Replaces all persisted cron rows for one store key from the config store snapshot.
 * The caller owns the shared-state write transaction; never nest another BEGIN here. */
export function replaceCronRows(
  db: DatabaseSync,
  storeKey: string,
  store: CronStoreFile,
  options?: {
    expectedStoreEpoch?: number;
    expectedTopologyFingerprintByJobId?: ReadonlyMap<string, string>;
    expectedRuntimeRevision?: number;
    expectedRuntimeStateByJobId?: ReadonlyMap<string, CronJob["state"] | undefined>;
    expectedRuntimeUpdatedAtMsByJobId?: ReadonlyMap<string, number>;
    bumpStoreEpoch?: boolean;
  },
): number {
  // This primitive is exported for transactional migrations as well as the public
  // save path; validate before DELETE so malformed preserved rows fail atomically.
  assertCronStoreCanPersist(store);
  const currentRows = loadCronRows(db, storeKey);
  const currentStoreEpoch = readCronStoreEpoch(db, storeKey);
  const currentRuntimeRevision = readCronRuntimeRevision(db, storeKey);
  if (
    options?.expectedStoreEpoch !== undefined &&
    options.expectedStoreEpoch !== currentStoreEpoch
  ) {
    throw new CronStoreEpochMismatchError(options.expectedStoreEpoch, currentStoreEpoch);
  }
  // A revision-blind writer may have already committed the caller's exact topology.
  // That is convergence, not a third conflicting state, so the replacement remains safe.
  const topologyMatchesIncoming = cronStoreTopologyMatches({
    rows: currentRows,
    store,
    normalizeJob: normalizeCronJobForSqlite,
    loadRow: (row) => {
      const loaded = loadedCronStoreFromRows([row]);
      return { job: loaded.store.jobs[0], configJob: loaded.configJobs[0] };
    },
  });
  if (options?.expectedTopologyFingerprintByJobId) {
    const currentTopology = new Map(
      currentRows.map((row) => [row.job_id, cronRowTopologyFingerprint(row)]),
    );
    if (
      !topologyMatchesIncoming &&
      (currentTopology.size !== options.expectedTopologyFingerprintByJobId.size ||
        [...currentTopology].some(
          ([jobId, fingerprint]) =>
            options.expectedTopologyFingerprintByJobId?.get(jobId) !== fingerprint,
        ))
    ) {
      throw new CronStoreTopologyMismatchError();
    }
  }
  const currentRowsByJobId = new Map(currentRows.map((row) => [row.job_id, row]));
  const expectedRuntimeRevision = options?.expectedRuntimeRevision;
  const expectedRuntimeStateByJobId = options?.expectedRuntimeStateByJobId;
  const expectedRuntimeUpdatedAtMsByJobId = options?.expectedRuntimeUpdatedAtMsByJobId;
  const preserveCurrentRuntime =
    expectedRuntimeStateByJobId !== undefined && expectedRuntimeUpdatedAtMsByJobId !== undefined;
  const runtimeRevisionChanged =
    expectedRuntimeRevision !== undefined && expectedRuntimeRevision !== currentRuntimeRevision;
  if (
    (runtimeRevisionChanged ||
      expectedRuntimeStateByJobId !== undefined ||
      expectedRuntimeUpdatedAtMsByJobId !== undefined) &&
    store.jobs.some(
      (job) =>
        currentRowsByJobId.has(job.id) &&
        (expectedRuntimeStateByJobId?.has(job.id) !== true ||
          expectedRuntimeUpdatedAtMsByJobId?.has(job.id) !== true),
    )
  ) {
    // A persisted row without a complete per-job baseline is ambiguous. Reject the
    // full snapshot so it cannot overwrite runtime state the caller never loaded.
    throw new CronRuntimeRevisionMismatchError(
      expectedRuntimeRevision ?? currentRuntimeRevision,
      currentRuntimeRevision,
    );
  }
  const topologyChanged = !topologyMatchesIncoming;
  const nextStoreEpoch =
    options?.bumpStoreEpoch && topologyChanged
      ? incrementCronStoreEpoch(db, storeKey)
      : currentStoreEpoch;
  // Persist zero for an empty partition so it has the same stale-writer
  // barrier as a nonempty one even before the first topology change.
  if (nextStoreEpoch === 0) {
    writeCronStoreEpoch(db, storeKey, nextStoreEpoch);
  }
  executeSqliteQuerySync(
    db,
    getCronStoreKysely(db).deleteFrom("cron_jobs").where("store_key", "=", storeKey),
  );
  for (const [index, job] of store.jobs.entries()) {
    const normalized = normalizeCronJobForSqlite(job);
    if (!normalized) {
      continue;
    }
    const currentRow = currentRowsByJobId.get(normalized.id);
    const expectedRuntimeState = expectedRuntimeStateByJobId?.get(normalized.id);
    const hasRuntimeBaseline = expectedRuntimeStateByJobId?.has(normalized.id) === true;
    const expectedRuntimeUpdatedAtMs = expectedRuntimeUpdatedAtMsByJobId?.get(normalized.id);
    const merged =
      !preserveCurrentRuntime || !currentRow || !hasRuntimeBaseline
        ? normalized
        : preserveConcurrentCronRuntime({
            current: rowToCronJob(currentRow) ?? undefined,
            next: normalized,
            expectedRuntimeState: expectedRuntimeState ?? {},
            expectedRuntimeUpdatedAtMs: expectedRuntimeUpdatedAtMs ?? normalized.updatedAtMs,
          });
    if (!merged) {
      throw new CronRuntimeRevisionMismatchError(
        expectedRuntimeRevision ?? currentRuntimeRevision,
        currentRuntimeRevision,
      );
    }
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .insertInto("cron_jobs")
        .values(bindCronJobRow(storeKey, merged, index)),
    );
  }
  incrementCronRuntimeRevision(db, storeKey);
  return nextStoreEpoch;
}

/** Upserts one persisted cron row without rewriting unrelated jobs in its store partition. */
export function upsertCronJobRow(
  db: DatabaseSync,
  storeKey: string,
  job: CronJob,
  sortOrder: number,
): number {
  const upsert = () => {
    const normalized = normalizeCronJobForSqlite(job);
    if (!normalized) {
      throw new Error(`Cannot persist invalid cron job ${job.id}`);
    }
    const values = bindCronJobRow(storeKey, normalized, sortOrder);
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .insertInto("cron_jobs")
        .values(values)
        .onConflict((conflict) => conflict.columns(["store_key", "job_id"]).doUpdateSet(values)),
    );
    // Row upserts replace runtime columns as well as topology. Advance both revisions
    // in this transaction so a stale runtime writer cannot interleave after the row write.
    incrementCronRuntimeRevision(db, storeKey);
    return incrementCronStoreEpoch(db, storeKey);
  };
  return db.isTransaction ? upsert() : runSqliteDeferredTransactionSync(db, upsert);
}

/** Updates only mutable runtime columns without rewriting full job config JSON. */
export function updateCronRuntimeRows(
  db: DatabaseSync,
  storeKey: string,
  store: CronStoreFile,
  options?: {
    expectedRuntimeRevision?: number;
    currentRuntimeRevision?: number;
    expectedRuntimeStateByJobId?: ReadonlyMap<string, CronJob["state"] | undefined>;
    expectedRuntimeUpdatedAtMsByJobId?: ReadonlyMap<string, number>;
  },
): number {
  const expectedRuntimeRevision = options?.expectedRuntimeRevision;
  const currentRuntimeRevision = options?.currentRuntimeRevision;
  const write = () =>
    writeCronRuntimeRowDeltas({
      db,
      storeKey,
      store,
      expectedRuntimeRevision,
      currentRuntimeRevision,
      expectedRuntimeStateByJobId: options?.expectedRuntimeStateByJobId,
      expectedRuntimeUpdatedAtMsByJobId: options?.expectedRuntimeUpdatedAtMsByJobId,
      scheduleIdentityFromRow: (row) => {
        const current = rowToCronJob(row);
        return current
          ? tryCronScheduleIdentity(current as unknown as Record<string, unknown>)
          : undefined;
      },
      conflictError: () =>
        new CronRuntimeRevisionMismatchError(
          expectedRuntimeRevision ?? 0,
          currentRuntimeRevision ?? 0,
        ),
      incrementRevision: () => incrementCronRuntimeRevision(db, storeKey),
    });
  return db.isTransaction ? write() : runSqliteDeferredTransactionSync(db, write);
}

/** Reconstructs loaded cron store data and config-runtime sidecars from SQLite rows. */
export function loadedCronStoreFromRows(
  rows: CronJobRow[],
  storeEpoch = 0,
  runtimeRevision = 0,
): LoadedCronStore {
  const parsedJobs = rows.map(rowToCronJob);
  const jobs = parsedJobs.filter((job): job is CronJob => job !== null);
  const configJobs = rows.map((row, index) =>
    mergeFailureDestinationProjection(
      parseJsonObject<Record<string, unknown>>(
        row.job_json,
        stripJobRuntimeFields(parsedJobs[index] ?? ({} as CronJob)),
      ),
      parsedJobs[index] ?? null,
    ),
  );
  const configJobRuntimeEntries = rows.map((row) => ({
    updatedAtMs: normalizeNumber(row.runtime_updated_at_ms) ?? normalizeNumber(row.updated_at),
    scheduleIdentity: row.schedule_identity ?? undefined,
    state: stateFromRow(row) as Record<string, unknown>,
  }));
  return {
    store: { version: 1, jobs },
    topologyFingerprintByJobId: new Map(
      rows.map((row) => [row.job_id, cronRowTopologyFingerprint(row)]),
    ),
    storeEpoch,
    runtimeRevision,
    configJobs,
    configJobIndexes: rows.map((_row, index) => index),
    legacyImportedJobIndexes: [],
    configJobRuntimeEntries,
    invalidConfigRows: [],
  };
}
