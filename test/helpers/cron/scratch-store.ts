import { captureCronMutationCommit } from "../../../src/cron/mutation-completion.js";
import {
  assertCronJobScratchContent,
  type CronJobScratchWriteResult,
} from "../../../src/cron/scratch-contract.js";
import { writeCronJobScratchInDatabase } from "../../../src/cron/scratch-write.kernel.js";
import { cronStoreKey } from "../../../src/cron/store/key.js";
import { getCronStoreKysely } from "../../../src/cron/store/schema.js";
import { executeSqliteQuerySync } from "../../../src/infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../../../src/infra/sqlite-post-commit.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../../src/state/openclaw-state-db.js";

/** Synchronous scratch fixtures use the canonical writer and commit receipts. */
export function writeCronJobScratchForMaintenance(params: {
  storePath: string;
  jobId: string;
  content: string | null;
  expectedRevision?: number;
  sourceSha256?: string;
  nowMs?: number;
  options?: OpenClawStateDatabaseOptions;
}): CronJobScratchWriteResult {
  if (params.content !== null) {
    assertCronJobScratchContent(params.content);
  }
  const input = {
    storeKey: cronStoreKey(params.storePath),
    jobId: params.jobId,
    content: params.content,
    expectedRevision: params.expectedRevision,
    sourceSha256: params.sourceSha256,
    nowMs: params.nowMs ?? Date.now(),
  };
  const markCommitted = captureCronMutationCommit("cron.scratch.set");
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const outcome = writeCronJobScratchInDatabase(db, input);
      if (outcome.written && markCommitted) {
        deferSqlitePostCommitPublication(db, markCommitted);
      }
      return outcome.result;
    },
    params.options,
    { operationLabel: "cron.scratch.write" },
  );
}

/** Remove fixture scratch only while its expected revision is still current. */
export function deleteCronJobScratch(
  storePath: string,
  jobId: string,
  options: OpenClawStateDatabaseOptions = {},
  guard?: { expectedRevision: number },
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const storeKey = cronStoreKey(storePath);
      const cronDb = getCronStoreKysely(db);
      if (guard) {
        const row = executeSqliteQuerySync(
          db,
          cronDb
            .selectFrom("cron_job_scratch")
            .select(["revision", "updated_at_ms"])
            .where("store_key", "=", storeKey)
            .where("job_id", "=", jobId),
        ).rows[0];
        const currentRevision = row?.revision ?? 0;
        if (currentRevision !== guard.expectedRevision) {
          return false;
        }
      }
      executeSqliteQuerySync(
        db,
        cronDb
          .deleteFrom("cron_job_scratch")
          .where("store_key", "=", storeKey)
          .where("job_id", "=", jobId),
      );
      return true;
    },
    options,
    { operationLabel: "cron.scratch.delete" },
  );
}
