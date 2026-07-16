/**
 * Best-effort cleanup of cron_jobs rows referencing a deleted agent.
 *
 * Uses the canonical cron store load/save path so writes go through the
 * same persistence the cron service uses. This avoids a competing writer
 * that could diverge from the service's in-memory snapshot.
 */
import { loadCronJobsStoreSync } from "../store.js";
import { resolveCronJobsStorePath, saveCronJobsStore } from "../store.js";

/** Delete cron_jobs rows keyed to a specific agent id. Errors are swallowed so
 *  a stale or unavailable state database never blocks agent deletion. */
export async function purgeAgentCronJobs(agentId: string): Promise<void> {
  try {
    const storePath = resolveCronJobsStorePath();
    const store = loadCronJobsStoreSync(storePath);
    const before = store.jobs.length;
    store.jobs = store.jobs.filter((job) => job.agentId !== agentId);
    if (store.jobs.length === before) {
      return;
    }
    await saveCronJobsStore(storePath, store);
  } catch {
    // Best-effort: a missing or locked DB must not prevent agent deletion.
  }
}
