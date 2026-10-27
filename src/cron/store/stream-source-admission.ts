import { assertLocalWorkspacePersistentExecutionCurrentInDatabase } from "../../gateway/worker-environments/local-workspace-store.kernel.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import { ownsStreamSource } from "../stream-schedule.js";
import { loadedCronStoreFromRows, loadCronRows } from "./row-codec.js";

/** Expected source supplied only by the retained stream execution owner. */
export type CronSandboxStreamSource = {
  storeKey: string;
  jobId: string;
  scheduleKey: string;
  sourceIdentity: string;
};

/** The custody worker calls the cron owner inside the same admitted transaction. */
export function assertCronSandboxStreamSourceInDatabase(
  db: EngineConnection,
  source: CronSandboxStreamSource,
): void {
  const rows = loadCronRows(db, source.storeKey, new Set([source.jobId]), {
    includeGrantDefinitionProjection: true,
  });
  const job = loadedCronStoreFromRows(rows).store.jobs[0];
  if (
    !job?.enabled ||
    !job.streamSandbox ||
    job.state.streamRestartExhausted ||
    !ownsStreamSource(job, source.scheduleKey, source.sourceIdentity)
  ) {
    throw new Error("The saved sandbox stream is no longer authorized to run.");
  }
  if (job.streamSandbox.workspaceSource === "managed-worktree") {
    assertLocalWorkspacePersistentExecutionCurrentInDatabase(db, job.streamSandbox);
  }
}
