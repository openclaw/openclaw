import { readDefaultProactiveJobReceiptInDatabase } from "../cron/proactive-job-receipt.js";
import { readScratchStateFromDatabase } from "../cron/scratch-read.kernel.js";
import { cronStoreKey } from "../cron/store/key.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";

export function readLegacyHeartbeatScratch(
  storePath: string,
  agentId: string,
  options: { env: NodeJS.ProcessEnv },
) {
  return withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
    const receipt = readDefaultProactiveJobReceiptInDatabase(db, storePath, agentId);
    if (receipt?.phase === "complete") {
      return undefined;
    }
    const cronDb = getCronStoreKysely(db);
    const storeKey = cronStoreKey(storePath);
    let job = cronDb.selectFrom("cron_jobs").select("job_id").where("store_key", "=", storeKey);
    job = receipt
      ? job.where("job_id", "=", receipt.jobId)
      : job.where("agent_id", "=", agentId).where("payload_kind", "=", "heartbeat");
    const jobs = executeSqliteQuerySync(db, job).rows;
    if (jobs.length > 1) {
      throw new Error(
        `Multiple legacy monitors for ${agentId}; resolve ownership before migration.`,
      );
    }
    if (!jobs[0]) {
      return undefined;
    }
    const jobId = jobs[0].job_id;
    return { jobId, state: readScratchStateFromDatabase(db, storeKey, jobId) };
  }, options);
}
