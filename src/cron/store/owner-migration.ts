import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { materializeLegacyDefaultCronJobOwnersInRecords } from "../legacy-default-agent-owner-records.js";
import type { CronJob } from "../types.js";
import { cronStoreKey } from "./key.js";
import {
  loadedCronStoreFromRows,
  incrementCronStoreEpoch,
  loadCronRowsWithEpoch,
  materializeCronRowAgentOwners,
  readCronStoreEpoch,
  upsertCronJobRow,
} from "./row-codec.js";
import { parseJsonObject } from "./scalar-codec.js";
import { getCronStoreKysely, type CronJobRow } from "./schema.js";

export type PreparedCronOwnerRollback = {
  storeKey: string;
  storePath: string;
  expectedStoreEpoch: number;
  observedBeforeRows: ReadonlyMap<string, CronJobRow>;
  changes: ReadonlyMap<
    string,
    {
      before: { exists: false } | { exists: true; row: CronJobRow };
      after: CronJobRow;
    }
  >;
};

function prepareCronOwnerRollback(params: {
  storeKey: string;
  storePath: string;
  beforeRows: readonly CronJobRow[];
  afterRows: readonly CronJobRow[];
  expectedStoreEpoch: number;
}): PreparedCronOwnerRollback {
  const beforeRows = new Map(params.beforeRows.map((row) => [row.job_id, row]));
  const afterRows = new Map(params.afterRows.map((row) => [row.job_id, row]));
  const changes = new Map<
    string,
    {
      before: { exists: false } | { exists: true; row: CronJobRow };
      after: CronJobRow;
    }
  >();
  for (const [jobId, after] of afterRows) {
    const before = beforeRows.get(jobId);
    if (before && isDeepStrictEqual(before, after)) {
      continue;
    }
    changes.set(jobId, {
      before: before ? { exists: true, row: before } : { exists: false },
      after,
    });
  }
  return {
    storeKey: params.storeKey,
    storePath: params.storePath,
    expectedStoreEpoch: params.expectedStoreEpoch,
    observedBeforeRows: beforeRows,
    changes,
  };
}

function restoreEarlierCandidateFields(params: {
  original: CronJobRow;
  candidate: CronJobRow;
  later: CronJobRow;
}): CronJobRow {
  const restored = { ...params.later } as Record<string, unknown>;
  const original = params.original as unknown as Record<string, unknown>;
  const candidate = params.candidate as unknown as Record<string, unknown>;
  for (const key of Object.keys(candidate)) {
    if (key === "job_json") {
      const originalJob = parseJsonObject<Record<string, unknown>>(String(original[key]), {});
      const candidateJob = parseJsonObject<Record<string, unknown>>(String(candidate[key]), {});
      const laterJob = parseJsonObject<Record<string, unknown>>(String(restored[key]), {});
      for (const jobKey of new Set([...Object.keys(originalJob), ...Object.keys(candidateJob)])) {
        if (
          !isDeepStrictEqual(originalJob[jobKey], candidateJob[jobKey]) &&
          isDeepStrictEqual(laterJob[jobKey], candidateJob[jobKey])
        ) {
          if (Object.hasOwn(originalJob, jobKey)) {
            laterJob[jobKey] = originalJob[jobKey];
          } else {
            delete laterJob[jobKey];
          }
        }
      }
      restored[key] = JSON.stringify(laterJob);
      continue;
    }
    if (
      !isDeepStrictEqual(original[key], candidate[key]) &&
      isDeepStrictEqual(restored[key], candidate[key])
    ) {
      restored[key] = original[key];
    }
  }
  return restored as CronJobRow;
}

/** Composes consecutive transaction-owned before-images into one reversible change set. */
export function mergePreparedCronOwnerRollbacks(
  earlier: PreparedCronOwnerRollback | undefined,
  later: PreparedCronOwnerRollback,
): PreparedCronOwnerRollback {
  if (!earlier) {
    return later;
  }
  if (earlier.storeKey !== later.storeKey) {
    throw new Error("cannot combine cron owner rollbacks from different stores");
  }
  const changes = new Map(earlier.changes);
  for (const [jobId, earlierChange] of changes) {
    const laterBefore = later.observedBeforeRows.get(jobId);
    if (!laterBefore) {
      const laterChange = later.changes.get(jobId);
      if (laterChange) {
        changes.set(jobId, laterChange);
      } else {
        // The later transaction authoritatively observed an epoch-blind deletion.
        // Preserve it instead of requiring the obsolete candidate row at rollback.
        changes.delete(jobId);
      }
      continue;
    }
    const laterAfter = later.changes.get(jobId)?.after ?? laterBefore;
    changes.set(jobId, {
      before:
        !earlierChange.before.exists && !isDeepStrictEqual(earlierChange.after, laterBefore)
          ? { exists: true, row: laterBefore }
          : earlierChange.before.exists && isDeepStrictEqual(earlierChange.after, laterBefore)
            ? earlierChange.before
            : earlierChange.before.exists
              ? {
                  exists: true,
                  row: restoreEarlierCandidateFields({
                    original: earlierChange.before.row,
                    candidate: earlierChange.after,
                    later: laterBefore,
                  }),
                }
              : earlierChange.before,
      after: laterAfter,
    });
  }
  for (const [jobId, laterChange] of later.changes) {
    const earlierChange = changes.get(jobId);
    if (earlierChange) {
      continue;
    }
    changes.set(jobId, {
      before: laterChange.before,
      after: laterChange.after,
    });
  }
  return {
    ...earlier,
    expectedStoreEpoch: later.expectedStoreEpoch,
    observedBeforeRows: later.observedBeforeRows,
    changes,
  };
}

/** Restores exact before-images only while the prepared topology remains current. */
export async function rollbackMaterializedCronJobsStoreOwners(params: {
  rollback: PreparedCronOwnerRollback;
  restoreMetadata?: (db: DatabaseSync) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, storeEpoch } = loadCronRowsWithEpoch(db, params.rollback.storeKey);
      if (storeEpoch !== params.rollback.expectedStoreEpoch) {
        throw new Error("cron store changed after owner handoff; refusing stale rollback");
      }
      const currentRows = new Map(rows.map((row) => [row.job_id, row]));
      for (const [jobId, change] of params.rollback.changes) {
        const current = currentRows.get(jobId);
        if (!current || !isDeepStrictEqual(current, change.after)) {
          throw new Error(`cron job ${jobId} changed after owner handoff; refusing stale rollback`);
        }
      }
      for (const [jobId, change] of params.rollback.changes) {
        executeSqliteQuerySync(
          db,
          getCronStoreKysely(db)
            .deleteFrom("cron_jobs")
            .where("store_key", "=", params.rollback.storeKey)
            .where("job_id", "=", jobId),
        );
        if (!change.before.exists) {
          continue;
        } else {
          executeSqliteQuerySync(
            db,
            getCronStoreKysely(db).insertInto("cron_jobs").values(change.before.row),
          );
        }
      }
      if (params.rollback.changes.size > 0) {
        incrementCronStoreEpoch(db, params.rollback.storeKey);
      }
      params.restoreMetadata?.(db);
      return params.rollback.changes.size;
    },
    { env: params.env },
  );
}

/** Materializes known rows and imports legacy-file jobs without replacing unrelated raw rows. */
export async function materializeCronJobsStoreOwners(params: {
  storePath: string;
  legacyDefaultAgentId: string;
  records: CronJob[];
  legacyImportedJobIds: ReadonlySet<string>;
  expectedStoreEpoch?: number;
  acquireMetadata?: (db: DatabaseSync) => boolean;
  recordCommittedStoreEpoch?: (storeEpoch: number) => void;
  recordMetadataAcquired?: () => void;
  recordPreparedRollback?: (rollback: PreparedCronOwnerRollback) => void;
  env?: NodeJS.ProcessEnv;
}): Promise<{ matched: boolean; rewritten: number }> {
  const storeKey = cronStoreKey(path.resolve(params.storePath));
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const { rows, storeEpoch } = loadCronRowsWithEpoch(db, storeKey);
      if (params.expectedStoreEpoch !== undefined && params.expectedStoreEpoch !== storeEpoch) {
        return { matched: false, metadataAcquired: false, rewritten: 0 } as const;
      }
      const metadataAcquired = params.acquireMetadata?.(db) ?? false;
      if (params.acquireMetadata && !metadataAcquired) {
        return { matched: false, metadataAcquired: false, rewritten: 0 } as const;
      }
      const existingJobIds = new Set(rows.map((row) => row.job_id));
      const decodedCurrentJobIds = new Set(
        loadedCronStoreFromRows(rows).store.jobs.map((job) => job.id),
      );
      // Current decodable rows are authoritative inside the transaction. Include rows
      // inserted after the caller's snapshot, while absent rows stay deleted and raw
      // undecodable rows remain outside the targeted update.
      const persistedJobIds = decodedCurrentJobIds;
      // Both row helpers advance the partition epoch inside this outer transaction,
      // so stale full-store writers cannot overwrite ownership or imported rows.
      let rewritten = materializeCronRowAgentOwners(db, storeKey, params.legacyDefaultAgentId, {
        jobIds: persistedJobIds,
      });
      let sortOrder = rows.reduce((maximum, row) => Math.max(maximum, row.sort_order), -1) + 1;
      for (const record of params.records) {
        if (!params.legacyImportedJobIds.has(record.id)) {
          continue;
        }
        if (existingJobIds.has(record.id)) {
          if (!decodedCurrentJobIds.has(record.id)) {
            throw new Error(
              `Cannot import legacy cron job "${record.id}": an undecodable SQLite row already uses that id`,
            );
          }
          continue;
        }
        const importedRecord = structuredClone(record);
        materializeLegacyDefaultCronJobOwnersInRecords(
          [importedRecord as unknown as Record<string, unknown>],
          params.legacyDefaultAgentId,
        );
        upsertCronJobRow(db, storeKey, importedRecord, sortOrder++);
        existingJobIds.add(record.id);
        rewritten += 1;
      }
      const committedStoreEpoch = readCronStoreEpoch(db, storeKey);
      return {
        matched: true,
        metadataAcquired,
        rewritten,
        storeEpoch: committedStoreEpoch,
        rollback: prepareCronOwnerRollback({
          storeKey,
          storePath: params.storePath,
          beforeRows: rows,
          afterRows: loadCronRowsWithEpoch(db, storeKey).rows,
          expectedStoreEpoch: committedStoreEpoch,
        }),
      } as const;
    },
    { env: params.env },
  );
  if (result.matched) {
    params.recordCommittedStoreEpoch?.(result.storeEpoch);
    if (result.metadataAcquired) {
      params.recordMetadataAcquired?.();
    }
    params.recordPreparedRollback?.(result.rollback);
  }
  return { matched: result.matched, rewritten: result.rewritten };
}
