/** Sends committed cron notifications through the live host and records delivery. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { noteCronJobsStoreCommit } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import type { CronFailureNotificationDelivery } from "../types.js";
import { locked } from "./locked.js";
import {
  captureCronNotificationRouting,
  resolveCronNotificationQueueOwner,
  type CronNotificationIntent,
  type CronNotificationRouting,
} from "./notification-intents.js";
import { runCronRuntimeMutation } from "./runtime-mutation.js";
import { applyCronRuntimeRowsToState } from "./runtime-publication.js";
import type { CronServiceState } from "./state.js";
import { enqueueCronNotification } from "./wake.js";

export async function dispatchCronNotification(
  state: CronServiceState,
  notification: CronNotificationIntent,
): Promise<void> {
  if (notification.kind === "failure-repair") {
    await requestFailureRepair(state, notification);
    return;
  }
  let routing = notification.routing ? { ...notification.routing } : undefined;
  if (!routing) {
    const hasOwner =
      notification.kind === "failure-alert" && state.deps.sendCronFailureAlert
        ? Boolean(notification.job.agentId?.trim())
        : Boolean(resolveCronNotificationQueueOwner(notification.job, notification.kind).agentId);
    routing = hasOwner
      ? {}
      : captureCronNotificationRouting(
          state.deps.resolveDefaultAgentId?.(),
          state.deps.defaultAgentId,
        );
  }
  if (notification.kind === "auto-disabled") {
    await enqueueCronNotification(
      state,
      notification.job,
      notification.text,
      notification.kind,
      routing,
    );
  } else {
    await transportFailureAlert(state, notification, routing);
  }
}

/**
 * Starts the repair turn in the conversation that owns the job. Request failures are logged;
 * terminal one-shots send their fallback alert, while recurring jobs alert on the next failure.
 */
async function requestFailureRepair(
  state: CronServiceState,
  notification: Extract<CronNotificationIntent, { kind: "failure-repair" }>,
): Promise<void> {
  const jobId = notification.job.id;
  const owner = state.store?.jobs.find((job) => job.id === jobId)?.owner;
  const sessionKey = owner?.sessionKey?.trim();
  const repairId = notification.job.state.lastFailureNotificationId;
  const failed = async (err: unknown) => {
    state.deps.log.warn({ jobId, err: String(err) }, "cron: failure repair request failed");
    if (notification.fallback) {
      await dispatchCronNotification(state, {
        ...notification.fallback,
        routing: notification.routing,
      });
    }
  };
  if (!sessionKey || !repairId || !state.deps.runCronFailureRepair) {
    await failed(new Error("Missing failure repair runner, owner session, or repair ID"));
    return;
  }
  void state.deps
    .runCronFailureRepair({
      jobId,
      repairId,
      agentId: owner?.agentId,
      sessionKey,
      message: notification.text,
    })
    .catch(failed)
    .catch((err: unknown) =>
      state.deps.log.warn({ jobId, err: String(err) }, "cron: failure repair fallback failed"),
    );
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
  let ownsCycle: boolean | undefined;
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
        // A replacement alert may race dispatch; the worker checks its persisted cycle.
        snapshot: {},
        publish(committed) {
          ownsCycle = committed.job !== undefined;
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
    return ownsCycle === false ? "stale" : "persistence-failed";
  }
}

async function transportFailureAlert(
  state: CronServiceState,
  params: Extract<CronNotificationIntent, { kind: "failure-alert" }>,
  routing: CronNotificationRouting,
): Promise<void> {
  const jobId = params.job.id;
  const alertAtMs = params.job.state.lastFailureAlertAtMs;
  const lifecycleGeneration = state.lifecycleGeneration;
  const notificationId = params.job.state.lastFailureNotificationId;
  const runAtMs = params.job.state.lastRunAtMs;
  if (!state.deps.sendCronFailureAlert) {
    // No transport means no send whose outcome could be recorded: the alert
    // goes straight to the in-app fallback queue and the intent stays
    // "unknown", matching the pre-existing contract for transport-less setups.
    await enqueueCronNotification(
      state,
      params.job,
      params.payload.text ?? "",
      "failure-alert",
      routing,
    );
    return;
  }
  void state.deps
    .sendCronFailureAlert({
      job: params.job,
      routing,
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
          await enqueueCronNotification(
            state,
            params.job,
            params.payload.text ?? "",
            "failure-alert",
            routing,
          );
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
