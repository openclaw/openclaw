import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveControlUiAutomationRunUrl } from "../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronCompletionDeliveryFence } from "../cron/delivery-attempt-fence.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import { retryTransientDirectCronDelivery } from "../cron/isolated-agent/delivery-dispatch-policy.js";
import { createCronExecutionId } from "../cron/run-id.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type { CronDeliveryTrace, CronJob, CronResolvedDeliveryState } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { getChildLogger } from "../logging.js";

export function pickDefined<T extends Record<string, unknown>>(
  obj: T,
  keys: (keyof T)[],
): Partial<T> {
  const result: Partial<T> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) {
      result[k] = obj[k];
    }
  }
  return result;
}

export async function finalizeCronCompletionAnnouncement(params: {
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
  job: CronJob;
  text?: string;
  suppressionReason?: NormalizeReplySkipReason;
  runStartedAtMs?: number;
  abortSignal?: AbortSignal;
  deps: CliDeps;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  logger: ReturnType<typeof getChildLogger>;
  label: string;
  traceResolvedFailure?: boolean;
}) {
  const plan = resolveCronDeliveryPlan(params.job);
  const delivery: CronDeliveryTrace = {
    intended: pickDefined(
      {
        channel: plan.channel,
        to: plan.to,
        accountId: plan.accountId,
        threadId: plan.threadId,
        source: "explicit" as const,
      },
      ["channel", "to", "accountId", "threadId", "source"],
    ),
  };
  if (plan.mode !== "announce") {
    return { deliveryAttempted: false, delivered: false, delivery };
  }
  const deliveryState: CronResolvedDeliveryState = {
    status: "not-delivered",
    delivered: false,
    failureNotification: { status: "not-requested" },
  };
  const finish = (deliveryAttempted: boolean) => ({
    deliveryAttempted,
    delivered: deliveryState.delivered,
    deliveryError: deliveryState.error,
    deliverySuppressionReason: deliveryState.deliverySuppressionReason,
    deliveryState,
    delivery: { ...delivery, delivered: deliveryState.delivered },
  });
  if (params.text === undefined) {
    deliveryState.deliverySuppressionReason = params.suppressionReason ?? "empty";
    return finish(false);
  }

  const { agentId, cfg } = params.resolveCronAgent(params.job.agentId);
  const inspectUrl = resolveControlUiAutomationRunUrl(cfg, {
    jobId: params.job.id,
    runId:
      params.runStartedAtMs === undefined
        ? undefined
        : createCronExecutionId(params.job.id, params.runStartedAtMs),
  });
  // Command summaries are already redacted; adding the link earlier would strip its URL.
  const text = inspectUrl ? `${params.text}\nInspect: ${inspectUrl}` : params.text;
  const abortSignal = params.abortSignal ?? new AbortController().signal;
  let deliveryMayHaveReachedRecipient = false;
  try {
    const result = await retryTransientDirectCronDelivery({
      jobId: params.job.id,
      label: params.label,
      signal: abortSignal,
      shouldRetryError: () => !deliveryMayHaveReachedRecipient,
      run: () =>
        sendCronAnnouncePayloadStrict({
          deps: params.deps,
          cfg,
          agentId,
          jobId: params.job.id,
          target: {
            channel: plan.channel,
            to: plan.to,
            threadId: plan.threadId,
            accountId: plan.accountId,
            sessionKey: resolveCronDeliverySessionKey(params.job),
          },
          payload: { text },
          abortSignal,
          ...(params.runStartedAtMs === undefined
            ? {}
            : {
                completion: {
                  job: params.job,
                  runStartedAt: params.runStartedAtMs,
                  deliveryAttemptFence: params.deliveryAttemptFence,
                },
              }),
          onDeliveryAttempt: (reachedRecipient) => {
            deliveryMayHaveReachedRecipient ||= reachedRecipient;
          },
        }),
    });
    if (result.status === "sent") {
      deliveryState.status = "delivered";
      deliveryState.delivered = true;
    } else {
      const uncertain = result.reason === "adapter_returned_no_identity";
      deliveryState.status = uncertain ? "unknown" : "not-delivered";
      deliveryState.delivered = uncertain ? undefined : false;
      deliveryState.error = `cron delivery ${uncertain ? "outcome is unknown" : "was suppressed"}: ${result.reason}`;
    }
    return finish(true);
  } catch (err) {
    const deliveryError = formatErrorMessage(err);
    params.logger.warn(
      { jobId: params.job.id, err: deliveryError },
      `cron: ${params.label} delivery failed`,
    );
    deliveryState.error = deliveryError;
    if (params.traceResolvedFailure) {
      delivery.resolved = {
        channel: plan.channel,
        to: plan.to,
        accountId: plan.accountId,
        threadId: plan.threadId,
        source: "explicit",
        ok: false,
        error: deliveryError,
      };
    }
    return finish(true);
  }
}
