import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { recordDefaultProactiveJobInDatabase } from "./proactive-job-receipt.js";
import { saveCronJobsStore } from "./store.js";
import { resolveCronStoreKeyInDatabase } from "./store/paths.js";
import type { CronStoredJob } from "./types.js";

/** Persist the same completed job/receipt pair that setup and Doctor own. */
export async function saveProactiveJobsForTest(storePath: string, jobs: CronStoredJob[]) {
  await saveCronJobsStore(storePath, { version: 1, jobs });
  runOpenClawStateWriteTransaction(({ db }) => {
    const storeKey = resolveCronStoreKeyInDatabase(db, storePath);
    for (const job of jobs) {
      if (!job.agentId) {
        throw new Error("Proactive diagnostic fixture requires an explicit owner");
      }
      recordDefaultProactiveJobInDatabase(db, storeKey, job.agentId, job.id, job.createdAtMs);
    }
  });
}
