/** Sends committed cron notifications through the live host and records delivery. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronFailureNotificationDelivery } from "../types.js";
import { locked } from "./locked.js";
import type { CronNotificationIntent } from "./notification-intents.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-store.js";
import type { CronServiceState } from "./state.js";
import { enqueueCronNotification } from "./wake.js";

export function dispatchCronNotification(
  state: CronServiceState,
  notification: CronNotificationIntent,
): void {
  if (notification.kind === "auto-disabled") {
    enqueueCronNotification(state, notification.job, notification.text, notification.kind);
  } else {
    transportFailureAlert(state, notification);
  }
}

type FailureAlertCycle = {
  alertAtMs: number | undefined;
  jobId: string;
  lifecycleGeneration: number;
  notificationId: string | undefined;
  runAtMs: number | undefined;
};

const FAILURE_ALERT_ERROR_MAX_LENGTH = 1_000;
type FailureAlertRecordResult = "recorded" | "stale" | "persistence-failed";

/** Writes one settled transport fact while the exact alert cycle still owns the row. */
async function recordFailureAlertOutcome(
  state: CronServiceState,
  cycle: FailureAlertCycle,
  outcome: CronFailureNotificationDelivery,
): Promise<FailureAlertRecordResult> {
  let ownsCycle = false;
  try {
    return await locked(state, async () => {
      if (state.stopped || state.lifecycleGeneration !== cycle.lifecycleGeneration) {
        return "stale";
      }
      const context = captureOpenClawStateWorkerContext();
      const storeKey = cronStoreKey(state.deps.storePath);
      let result: FailureAlertRecordResult = "stale";
      await runCronRuntimeMutation({
        context,
        type: "cron.recordFailureAlertOutcome",
        input: {
          storeKey,
          jobId: cycle.jobId,
          runAtMs: cycle.runAtMs,
          alertAtMs: cycle.alertAtMs,
          notificationId: cycle.notificationId,
          outcome: {
            ...outcome,
            error: outcome.error
              ? truncateUtf16Safe(formatErrorMessage(outcome.error), FAILURE_ALERT_ERROR_MAX_LENGTH)
              : undefined,
          },
        },
        assertCurrent() {
          if (state.stopped || state.lifecycleGeneration !== cycle.lifecycleGeneration) {
            ownsCycle = false;
            throw new Error("Cron failure-alert owner retired");
          }
        },
        prepare(facts) {
          ownsCycle = facts.ownsCycle;
          return { value: {}, assertCurrent() {} };
        },
        publish(committed) {
          if (committed.job) {
            noteCronJobsStoreCommit(storeKey);
            applyCronRuntimeRowsToState(state, [committed.job], [], { publish: false });
            result = "recorded";
          }
        },
      });
      return result;
    });
  } catch (err) {
    state.deps.log.warn(
      { jobId: cycle.jobId, err: formatErrorMessage(err) },
      "cron: failed to record failure-alert outcome",
    );
    return ownsCycle ? "persistence-failed" : "stale";
  }
}

function transportFailureAlert(
  state: CronServiceState,
  params: Extract<CronNotificationIntent, { kind: "failure-alert" }>,
): void {
  const jobId = params.job.id;
  const alertAtMs = params.job.state.lastFailureAlertAtMs;
  const lifecycleGeneration = state.lifecycleGeneration;
  const notificationId = params.job.state.lastFailureNotificationId;
  const runAtMs = params.job.state.lastRunAtMs;
  if (!state.deps.sendCronFailureAlert) {
    // No transport means no send whose outcome could be recorded: the alert
    // goes straight to the in-app fallback queue and the intent stays
    // "unknown", matching the pre-existing contract for transport-less setups.
    enqueueCronNotification(state, params.job, params.payload.text ?? "", "failure-alert");
    return;
  }
  void state.deps
    .sendCronFailureAlert({
      job: params.job,
      payload: params.payload,
      runAtMs: params.runAtMs,
      channel: params.route.channel,
      to: params.route.to,
      mode: params.route.mode,
      accountId: params.route.accountId,
      threadId: params.route.threadId,
      ...(params.route.alternateRoute ? { inheritSessionThread: false as const } : {}),
      onDeliverySettled: async (outcome) => {
        const recordResult = await recordFailureAlertOutcome(
          state,
          { jobId, alertAtMs, runAtMs, lifecycleGeneration, notificationId },
          outcome,
        );
        if (recordResult !== "stale" && outcome.status === "not-delivered") {
          enqueueCronNotification(state, params.job, params.payload.text ?? "", "failure-alert");
        }
      },
    })
    .catch((err: unknown) => {
      state.deps.log.warn(
        { jobId: params.job.id, err: String(err) },
        "cron: failure alert delivery failed",
      );
    });
}
