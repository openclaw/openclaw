import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { getCronJobsStoreRevision } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { emitInterruptedCronRun } from "./run-recovery-events.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import type { CronServiceState } from "./state.js";
import { noteLoadedCronStoreCommit, runPostPersistCronNotifications } from "./store.js";

export async function recoverCronRuns(state: CronServiceState): Promise<Set<string>> {
  const storeKey = cronStoreKey(state.deps.storePath);
  const observedRevision = getCronJobsStoreRevision(storeKey);
  const outcome = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(), {
    type: "cron.recoverRuns",
    input: {
      storeKey,
      nowMs: state.deps.nowMs(),
      cronConfig: state.deps.cronConfig,
      failureRepairTimeoutMs: state.deps.failureRepairTimeoutMs,
    },
  });
  applyCronRuntimeRowsToState(state, outcome.jobs, outcome.removedJobIds);
  noteLoadedCronStoreCommit(state, observedRevision);
  for (const entry of outcome.logs) {
    state.deps.log[entry.level](entry.fields, entry.message);
  }
  for (const interrupted of outcome.interruptedRuns) {
    emitInterruptedCronRun(state, interrupted);
  }
  void runPostPersistCronNotifications(state, outcome.notifications).catch((error: unknown) => {
    state.deps.log.warn({ err: String(error) }, "cron: recovery notification dispatch failed");
  });
  return new Set(outcome.skipJobIds);
}
