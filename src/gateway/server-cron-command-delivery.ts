import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveControlUiAutomationRunUrl } from "../config/control-ui-link-base.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveCronDeliveryPlan, sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import { retryTransientDirectCronDelivery } from "../cron/isolated-agent/delivery-dispatch-policy.js";
import { createCronExecutionId } from "../cron/run-id.js";
import type { CronCommandTaskIdentity } from "../cron/service/state.js";
import { resolveCronDeliverySessionKey } from "../cron/session-target.js";
import type { CronDeliveryTrace, CronJob, CronResolvedDeliveryState } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createCommandCronDeliveryCustody } from "../infra/outbound/delivery-completion.js";

/** Finalizes runtime-owned command output through durable recipient custody. */
export async function finalizeCronCompletionAnnouncement(params: {
  job: CronJob;
  text?: string;
  suppressionReason?: NormalizeReplySkipReason;
  runStartedAtMs?: number;
  abortSignal?: AbortSignal;
  deps: CliDeps;
  resolveCronAgent: (requested?: string | null) => { agentId: string; cfg: OpenClawConfig };
  logger: { warn: (obj: object, msg?: string) => void };
  label: string;
  traceResolvedFailure?: boolean;
  taskIdentity?: CronCommandTaskIdentity;
}) {
  const plan = resolveCronDeliveryPlan(params.job);
  const delivery: CronDeliveryTrace = {
    intended: {
      ...(plan.channel !== undefined ? { channel: plan.channel } : {}),
      ...(plan.to !== undefined ? { to: plan.to } : {}),
      ...(plan.accountId !== undefined ? { accountId: plan.accountId } : {}),
      ...(plan.threadId !== undefined ? { threadId: plan.threadId } : {}),
      source: "explicit",
    },
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
  const text = inspectUrl ? `${params.text}\nInspect: ${inspectUrl}` : params.text;
  const abortSignal = params.abortSignal ?? new AbortController().signal;
  const custody = params.taskIdentity
    ? createCommandCronDeliveryCustody(params.taskIdentity)
    : undefined;
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
          ...custody,
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
  } catch (error) {
    const deliveryError = formatErrorMessage(error);
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
