/** Best-effort cleanup of cron_jobs rows referencing a deleted agent. */
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { getCronStoreKysely } from "./schema.js";

/** Delete cron_jobs rows keyed to a specific agent id. Errors are swallowed so
 *  a stale or unavailable state database never blocks agent deletion. */
export function purgeAgentCronJobs(agentId: string): void {
  try {
    const { db } = openOpenClawStateDatabase();
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db).deleteFrom("cron_jobs").where("agent_id", "=", agentId),
    );
  } catch {
    // Best-effort: a missing or locked DB must not prevent agent deletion.
  }
}
