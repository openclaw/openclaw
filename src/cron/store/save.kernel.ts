import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
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
  replaceCronRows,
  upsertCronJobRow,
  updateCronRuntimeRows,
} from "./row-codec.js";
import {
  loadCronRuntimeAuthorities,
  repairCronRuntimeAuthorityRows,
  replaceCronRuntimeAuthorityRows,
} from "./runtime-authority-store.js";
import { CronJobsStoreChangedError } from "./save-error.js";
import type {
  CronStoreChangesOptions,
  CronStoreSaveOptions,
  PreparedCronStoreChanges,
} from "./save.types.js";
import type { CronAdmittedStoreTransactionHooks } from "./transaction-hooks.types.js";

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
export function assertCronStoreChangesCurrent(
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

/** Applies prepared changes inside the caller's synchronous write transaction. */
export function saveCronStoreChangesInDatabase(
  db: DatabaseSync,
  storeKey: string,
  resolvedStorePath: string,
  prepared: PreparedCronStoreChanges,
  opts?: CronStoreChangesOptions,
  hooks?: CronAdmittedStoreTransactionHooks,
): CronStoreFile {
  const { previousById, nextById, changedIds } = prepared;
  const rows = loadCronRows(db, storeKey);
  const rowsById = new Map(rows.map((row) => [row.job_id, row] as const));
  const currentJobs = loadedCronStoreFromRows(rows).store.jobs;
  const authority = loadCronRuntimeAuthorities({ db, storeKey, jobs: currentJobs });
  if (authority.repairJobIds.length > 0) {
    repairCronRuntimeAuthorityRows({
      db,
      storeKey,
      jobs: currentJobs,
      jobIds: authority.repairJobIds,
    });
  }
  const currentById = new Map(currentJobs.map((job) => [job.id, job] as const));
  hooks?.hooks.beforeWrite?.(db, hooks.receiptSchema);
  assertCronStoreChangesCurrent(prepared, currentById, resolvedStorePath, opts);
  let nextSortOrder = rows.reduce((max, row) => Math.max(max, row.sort_order), -1) + 1;
  for (const jobId of changedIds) {
    const before = previousById.get(jobId);
    const after = nextById.get(jobId);
    const current = currentById.get(jobId);
    if (!after) {
      if (current) {
        deleteCronJobRowInDatabase(db, storeKey, jobId);
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
    const persisted = upsertCronJobRow(
      db,
      storeKey,
      merged,
      rowsById.get(jobId)?.sort_order ?? nextSortOrder++,
    );
    if (hasCanonicalCronDeliveryMode(persisted.delivery)) {
      replaceCronRuntimeAuthorityRows({ db, storeKey, jobs: [persisted] });
      currentById.set(jobId, persisted);
    }
  }
  hooks?.hooks.afterWrite?.(db, hooks.receiptSchema);
  return { version: 1, jobs: [...currentById.values()] } satisfies CronStoreFile;
}

function replaceCronStoreRowsInDatabase(
  db: DatabaseSync,
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
