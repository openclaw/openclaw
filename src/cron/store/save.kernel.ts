import { isDeepStrictEqual, toUSVString } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../../infra/sql-connection.js";
import { createSqliteSchemaEnsurer } from "../../infra/sqlite-schema-ensure.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { ensureStatePostgresFragment } from "../../state/openclaw-state-db-engine.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { getOpenClawStateFeatureSchemaSql } from "../../state/openclaw-state-feature-schema.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { normalizeCronRuntimeAuthority } from "../runtime-authority.js";
import type { CronJobState, CronStoredJob, CronStoreFile } from "../types.js";
import { hasCanonicalCronDeliveryMode } from "./delivery-codec.js";
import {
  deleteCronQuarantinedJobsFromDatabase,
  prepareCronQuarantineRegistration,
  registerCronQuarantineInDatabase,
} from "./quarantine.kernel.js";
import {
  deleteCronJobRowInDatabase,
  loadedCronStoreFromRows,
  loadCronRows,
  projectCronJobThroughStorageCodec,
  replaceCronRows,
  upsertCronJobRow,
  updateCronRuntimeRows,
} from "./row-codec.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
  applyCronRuntimeAuthorityRow,
  CRON_RUNTIME_AUTHORITY_TABLE,
  cronRuntimeAuthorityInputFingerprint,
  getCronAuthorityKysely,
  loadCronRuntimeAuthorityRows,
  writeRecoveryRow,
} from "./runtime-authority-store.js";
import { CronJobsStoreChangedError } from "./save-error.js";
import type {
  CronStoreChangesOptions,
  CronStoreSaveOptions,
  PreparedCronStoreChanges,
} from "./save.types.js";
import type { CronAdmittedStoreTransactionHooks } from "./transaction-hooks.types.js";

const ensureCronRuntimeAuthorityTable = createSqliteSchemaEnsurer(
  () => getOpenClawStateFeatureSchemaSql(CRON_RUNTIME_AUTHORITY_TABLE),
  { tables: [CRON_RUNTIME_AUTHORITY_TABLE] },
);

function mergeCronRuntimeChanges(
  previous: CronJobState,
  next: CronJobState,
  current: CronJobState,
): CronJobState {
  const merged = structuredClone(current);
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (isDeepStrictEqual(Reflect.get(previous, key), Reflect.get(next, key))) {
      continue;
    }
    if (Object.hasOwn(next, key)) {
      Reflect.set(merged, key, structuredClone(Reflect.get(next, key)));
    } else {
      Reflect.deleteProperty(merged, key);
    }
  }
  if (previous.runningAtMs !== next.runningAtMs) {
    merged.runningReceiptId =
      next.runningAtMs === current.runningAtMs ? current.runningReceiptId : next.runningReceiptId;
  }
  return merged;
}

function mergeCronRuntimeAuthority(
  previous: CronStoredJob,
  next: CronStoredJob,
  current: CronStoredJob,
): CronStoredJob {
  const merged = { ...next };
  const source =
    !isDeepStrictEqual(previous.runtimeAuthority, next.runtimeAuthority) ||
    previous.runtimeAuthorityRecoveryRequired !== next.runtimeAuthorityRecoveryRequired
      ? next
      : current;
  if (source.runtimeAuthority) {
    merged.runtimeAuthority = source.runtimeAuthority;
  } else {
    delete merged.runtimeAuthority;
  }
  if (source.runtimeAuthorityRecoveryRequired === true) {
    merged.runtimeAuthorityRecoveryRequired = true;
  } else {
    delete merged.runtimeAuthorityRecoveryRequired;
  }
  return merged;
}

export function prepareCronStoreChanges(
  previous: CronStoreFile,
  next: CronStoreFile,
): PreparedCronStoreChanges {
  const previousById = new Map(previous.jobs.map((job) => [job.id, job] as const));
  const nextById = new Map(next.jobs.map((job) => [job.id, job] as const));
  const changedIds = new Set(
    [...new Set([...previousById.keys(), ...nextById.keys()])].filter(
      (jobId) => !isDeepStrictEqual(previousById.get(jobId), nextById.get(jobId)),
    ),
  );
  return { previousById, nextById, changedIds };
}

/** Both save modes fence only the definitions this mutation intends to change. */
function assertCronStoreChangesCurrent(
  prepared: PreparedCronStoreChanges,
  currentById: ReadonlyMap<string, CronStoredJob>,
  resolvedStorePath: string,
  opts?: CronStoreChangesOptions,
): void {
  for (const jobId of prepared.changedIds) {
    const before = prepared.previousById.get(jobId);
    const after = prepared.nextById.get(jobId);
    const current = currentById.get(jobId);
    if (
      (before &&
        current &&
        resolveCronJobConfigRevision(current) !== resolveCronJobConfigRevision(before)) ||
      (after && before && !current) ||
      (after && !before && current && !opts?.preserveConcurrentAdds)
    ) {
      throw new CronJobsStoreChangedError(resolvedStorePath);
    }
  }
}

/** Load once inside the write transaction and share with mutation planning. */
export function loadCronStoreForChanges(db: EngineConnection, storeKey: string) {
  const rows = loadCronRows(db, storeKey, undefined, { includeGrantDefinitionProjection: true });
  const store = loadedCronStoreFromRows(rows).store;
  const currentJobs = store.jobs;
  const authority = loadCronRuntimeAuthorities({ db, storeKey, jobs: currentJobs });
  if (authority.repairJobIds.length > 0) {
    repairCronRuntimeAuthorityRows({
      db,
      storeKey,
      jobs: currentJobs,
      jobIds: authority.repairJobIds,
    });
  }
  const names = new Map(rows.map((row) => [row.job_id, normalizeOptionalString(row.name)]));
  return { rows, store, names };
}

/** Applies prepared changes inside the caller's synchronous write transaction. */
export function saveCronStoreChangesInDatabase(
  db: EngineConnection,
  storeKey: string,
  resolvedStorePath: string,
  prepared: PreparedCronStoreChanges,
  inventory: ReturnType<typeof loadCronStoreForChanges>,
  opts?: CronStoreChangesOptions,
  hooks?: CronAdmittedStoreTransactionHooks,
): CronStoreFile {
  const { previousById, nextById, changedIds } = prepared;
  const { rows, store, names } = inventory;
  const rowsById = new Map(rows.map((row) => [row.job_id, row] as const));
  const currentById = new Map(store.jobs.map((job) => [job.id, job] as const));
  // Change-save hooks own receipts, not the loaded job definitions or grants.
  hooks?.hooks.beforeWrite?.(db, hooks.receiptSchema);
  assertCronStoreChangesCurrent(prepared, currentById, resolvedStorePath, opts);
  let nextSortOrder = rows.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1;
  // Each canonical job is upserted once. Repeated upserts would need the preceding
  // write's generation copied back into rowsById before the next upsert.
  for (const jobId of changedIds) {
    const before = previousById.get(jobId);
    const after = nextById.get(jobId);
    const current = currentById.get(jobId);
    if (!after) {
      if (current) {
        deleteCronJobRowInDatabase(db, storeKey, jobId);
        names.delete(jobId);
      }
      currentById.delete(jobId);
      continue;
    }
    if (!before && current && opts?.preserveConcurrentAdds) {
      continue;
    }
    const merged: CronStoredJob = current
      ? {
          ...mergeCronRuntimeAuthority(before ?? after, after, current),
          state: mergeCronRuntimeChanges(before?.state ?? {}, after.state, current.state),
          updatedAtMs: Math.max(after.updatedAtMs, current.updatedAtMs),
        }
      : after;
    const existingRow =
      rowsById.get(toUSVString(normalizeOptionalString(merged.id) ?? merged.id)) ?? null;
    const persisted = upsertCronJobRow(
      db,
      storeKey,
      merged,
      rowsById.get(jobId)?.sort_order ?? nextSortOrder++,
      { knownExistingRow: existingRow },
    );
    if (hasCanonicalCronDeliveryMode(persisted.delivery)) {
      replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [persisted] });
      const postimage = projectCronJobThroughStorageCodec(persisted);
      if (persisted.runtimeAuthorityRecoveryRequired === true) {
        postimage.runtimeAuthorityRecoveryRequired = true;
      } else if (persisted.runtimeAuthority) {
        postimage.runtimeAuthority = persisted.runtimeAuthority;
      }
      currentById.set(jobId, postimage);
      names.set(toUSVString(persisted.id), normalizeOptionalString(toUSVString(persisted.name)));
    }
  }
  hooks?.hooks.afterWrite?.(db, hooks.receiptSchema);
  return { version: 1, jobs: [...currentById.values()] } satisfies CronStoreFile;
}

function replaceCronStoreRowsInDatabase(
  db: EngineConnection,
  storeKey: string,
  store: CronStoreFile,
  preserveRuntimeState: boolean,
): void {
  const replaced = replaceCronRows(db, storeKey, store, { preserveRuntimeState });
  replaceCronRuntimeAuthorityRows({
    db,
    storeKey,
    jobs: replaced.jobs.filter((job) => hasCanonicalCronDeliveryMode(job.delivery)),
    preserveExistingForJobIds: preserveRuntimeState ? replaced.existingJobIds : undefined,
    writeMissingForJobIds: preserveRuntimeState ? replaced.legacyAuthorityJobIds : undefined,
  });
}

export function isCronRuntimeOnlySave(opts?: CronStoreSaveOptions): boolean {
  return (
    opts?.stateOnly === true &&
    !opts.quarantine?.entries.length &&
    !opts.deleteQuarantineEntries?.length
  );
}

/** Persists a validated store inside the caller's synchronous write transaction. */
export function saveCronStoreInDatabase(
  database: OpenClawStateDatabase,
  storeKey: string,
  store: CronStoreFile,
  opts?: CronStoreSaveOptions,
  hooks?: CronAdmittedStoreTransactionHooks,
): void {
  const stateOnly = isCronRuntimeOnlySave(opts);
  hooks?.hooks.beforeWrite?.(database.db, hooks.receiptSchema);
  if (opts?.quarantine?.entries.length) {
    registerCronQuarantineInDatabase(
      database.db,
      prepareCronQuarantineRegistration({ storePath: storeKey, ...opts.quarantine }),
    );
  }
  if (opts?.deleteQuarantineEntries?.length) {
    deleteCronQuarantinedJobsFromDatabase({
      database: database.db,
      storePath: storeKey,
      entries: opts.deleteQuarantineEntries,
    });
  }
  // Hot-path timer updates mutate runtime columns only; malformed-row
  // quarantine and full replacement commit together or roll back together.
  if (stateOnly) {
    updateCronRuntimeRows(database.db, storeKey, store);
    hooks?.hooks.afterWrite?.(database.db, hooks.receiptSchema);
    return;
  }
  replaceCronStoreRowsInDatabase(database.db, storeKey, store, opts?.preserveRuntimeState === true);
  hooks?.hooks.afterWrite?.(database.db, hooks.receiptSchema);
}

/** Reconciles child rows inside the same transaction as their owning cron rows. */
export function replaceCronRuntimeAuthorityRows(params: {
  db: EngineConnection;
  storeKey: string;
  jobs: readonly CronStoredJob[];
  preserveExistingForJobIds?: ReadonlySet<string>;
  writeMissingForJobIds?: ReadonlySet<string>;
}): void {
  const hasPersistedAuthority = params.jobs.some(
    (job) => job.runtimeAuthority || job.runtimeAuthorityRecoveryRequired === true,
  );
  if (!hasPersistedAuthority && !tableExists(params.db, CRON_RUNTIME_AUTHORITY_TABLE)) {
    return;
  }
  if (isPostgresSqlConnection(params.db)) {
    ensureStatePostgresFragment(params.db, CRON_RUNTIME_AUTHORITY_TABLE);
  } else {
    ensureCronRuntimeAuthorityTable(params.db);
  }
  const database = getCronAuthorityKysely(params.db);
  const existingRowsByJobId = params.preserveExistingForJobIds
    ? new Map(
        loadCronRuntimeAuthorityRows(
          params.db,
          params.storeKey,
          params.jobs.map((job) => job.id),
        ).map((row) => [row.job_id, row]),
      )
    : undefined;
  for (const job of params.jobs) {
    // Doctor must not replay a pre-prompt authority snapshot. Keep the current
    // child only while its inputs match; missing stays missing unless legacy job_json owns it.
    if (params.preserveExistingForJobIds?.has(job.id)) {
      const existingRow = existingRowsByJobId?.get(job.id);
      if (existingRow) {
        if (applyCronRuntimeAuthorityRow(job, existingRow) === "repair") {
          writeRecoveryRow(params.db, params.storeKey, job.id);
        }
        continue;
      }
      if (!params.writeMissingForJobIds?.has(job.id)) {
        continue;
      }
    }
    if (job.runtimeAuthorityRecoveryRequired === true) {
      writeRecoveryRow(params.db, params.storeKey, job.id);
      continue;
    }
    const authority = normalizeCronRuntimeAuthority(job.runtimeAuthority);
    if (authority) {
      const authorityJson = JSON.stringify(authority);
      const authorityInputFingerprint = cronRuntimeAuthorityInputFingerprint(job);
      executeSqliteQuerySync(
        params.db,
        database
          .insertInto("cron_job_runtime_authorities")
          .values({
            store_key: params.storeKey,
            job_id: job.id,
            authority_json: authorityJson,
            authority_input_fingerprint: authorityInputFingerprint,
            recovery_required: 0,
          })
          .onConflict((conflict) =>
            conflict.columns(["store_key", "job_id"]).doUpdateSet({
              authority_json: authorityJson,
              authority_input_fingerprint: authorityInputFingerprint,
              recovery_required: 0,
            }),
          ),
      );
      continue;
    }
    executeSqliteQuerySync(
      params.db,
      database
        .deleteFrom("cron_job_runtime_authorities")
        .where("store_key", "=", params.storeKey)
        .where("job_id", "=", job.id),
    );
  }
}
