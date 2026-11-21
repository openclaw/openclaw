/** Sends committed cron notifications through the live host and records delivery. */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../agents/timeout.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { noteCronJobsStoreCommit } from "../store.js";
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
 * Asks the agent in the conversation that owns the job to follow up on the failure notice,
 * which has already settled. A repair that cannot run changes nothing the user was told.
 */
function requestFailureRepair(
  state: CronServiceState,
  job: Extract<CronNotificationIntent, { kind: "failure-alert" }>["job"],
  message: string,
): void {
  const jobId = job.id;
  const owner = state.store?.jobs.find((candidate) => candidate.id === jobId)?.owner;
  const sessionKey = owner?.sessionKey?.trim();
  const repairId = job.state.lastFailureNotificationId;
  if (!sessionKey || !repairId || !state.deps.runCronFailureRepair) {
    state.deps.log.warn({ jobId }, "cron: failure repair has no owner conversation or runner");
    return;
  }
  void state.deps
    .runCronFailureRepair({
      jobId,
      repairId,
      timeoutMs: state.deps.failureRepairTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
      agentId: owner?.agentId,
      sessionKey,
      message,
    })
    .catch((err: unknown) =>
      state.deps.log.warn({ jobId, err: String(err) }, "cron: failure repair request failed"),
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
      const storeKey = state.deps.storeKey;
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
    if (params.repair) {
      requestFailureRepair(state, params.job, params.repair);
    }
    return;
  }
  // The transport resolves after the notice settles, so the repair never arrives first.
  const followUp = () => {
    if (params.repair) {
      requestFailureRepair(state, params.job, params.repair);
    }
  };
  void state.deps
    .sendCronFailureAlert({
      job: params.job,
      routing,
      payload: params.payload,
      runAtMs: params.runAtMs,
      channel: params.route.channel,
      target: params.route.target,
      directPolicy: params.route.directPolicy,
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
            {
              privateFallback:
                params.route.target === "owner" || params.route.directPolicy === "block",
            },
          );
        }
      },
    })
    .then(followUp, (err: unknown) => {
      state.deps.log.warn(
        { jobId: params.job.id, err: String(err) },
        "cron: failure alert delivery failed",
      );
      followUp();
    });
}
