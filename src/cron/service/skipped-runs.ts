import { isCronJobActive } from "../active-jobs.js";
import { noteCronJobsStoreCommit } from "../store.js";
import type { CronRunHistorySource } from "../store/run-history.js";
import type {
  CronRuntimeMutationContracts,
  CronRuntimeMutationInputs,
} from "../store/runtime-worker.types.js";
import { captureCronNotificationRouting } from "./notification-intents.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import type { CronServiceState } from "./state.js";
import { captureCronServiceMutationSource } from "./store.js";

type SchedulerSource = ReturnType<typeof captureCronServiceMutationSource>;
type SkippedOutcome = CronRuntimeMutationContracts["cron.recordSkippedRuns"]["outcome"];

/** Publish history and other effects after the worker transaction completes. */
export async function recordSkippedCronRuns(params: {
  state: CronServiceState;
  source: SchedulerSource;
  change: CronRuntimeMutationInputs["cron.recordSkippedRuns"]["change"];
  nowMs: number;
  afterCommit: (outcome: SkippedOutcome, historySource: CronRunHistorySource) => Promise<void>;
}): Promise<void> {
  const { state, source } = params;
  let committed: SkippedOutcome | undefined;
  const defaultAgentId = state.deps.resolveDefaultAgentId
    ? state.deps.resolveDefaultAgentId()
    : state.deps.defaultAgentId;
  const historySource: CronRunHistorySource = {
    context: source.context,
    storeKey: source.storeKey,
    defaultAgentId: defaultAgentId ?? state.deps.defaultAgentId,
  };
  let failure: { error: unknown } | undefined;
  try {
    await runCronRuntimeMutation({
      context: source.context,
      type: "cron.recordSkippedRuns",
      input: { storeKey: source.storeKey, change: params.change },
      assertCurrent: () => source.assertCurrent(),
      // Routing and activity may change after submission; this snapshot owns the outcome.
      snapshot: {
        nowMs: params.nowMs,
        defaultAgentId,
        notificationRouting: captureCronNotificationRouting(
          defaultAgentId,
          state.deps.defaultAgentId,
        ),
        cronConfig: state.deps.cronConfig,
        failureRepairTimeoutMs: state.deps.failureRepairTimeoutMs,
        ownership: (state.store?.jobs ?? []).map((job) => ({
          jobId: job.id,
          active: isCronJobActive(job.id),
        })),
      },
      publish(outcome) {
        committed = outcome;
        if (outcome.jobs.length > 0) {
          noteCronJobsStoreCommit(source.storeKey);
        }
      },
    });
  } catch (error) {
    noteCronJobsStoreCommit(source.storeKey);
    failure = { error };
  }
  if (committed) {
    try {
      await params.afterCommit(committed, historySource);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
  if (!committed) {
    throw new Error("Cron skipped run did not publish its committed outcome");
  }
}
