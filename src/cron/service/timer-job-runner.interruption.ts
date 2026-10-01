// Pure interruption-outcome mapping for cron runs; kept separate so the
// cancellation/timeout branches and their invariants are directly testable.
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob, CronWebhookDeliveryOutcome } from "../types.js";
import type { IsolatedAgentSetupTimeoutSignal } from "./timer-execution-timeout.js";
import type { executeJobCore } from "./timer-execution.js";

export type CronCoreRunOutcome = Awaited<ReturnType<typeof executeJobCore>> & {
  isolatedAgentSetupTimeout?: IsolatedAgentSetupTimeoutSignal;
};
export type CronRunProgress = {
  completedCoreResult?: CronCoreRunOutcome;
  webhookDelivery?: CronWebhookDeliveryOutcome;
  settledDeliveryResult?: CronCoreRunOutcome;
};

export function withPrimaryWebhookTrace(params: {
  job: CronJob;
  result: CronCoreRunOutcome;
  outcome: CronWebhookDeliveryOutcome;
  error?: string;
  deliverySuppressionReason?: "empty";
}): CronCoreRunOutcome {
  const delivered =
    params.outcome.status === "unknown" ? undefined : params.outcome.status === "delivered";
  const error =
    params.outcome.status === "delivered"
      ? undefined
      : params.outcome.error && params.error && params.outcome.error !== params.error
        ? `${params.outcome.error}; ${params.error}`
        : (params.error ?? params.outcome.error);
  const plan = resolveCronDeliveryPlan(params.job);
  const intended = params.result.delivery?.intended ?? {
    to: plan.to,
    source: "explicit" as const,
  };
  return {
    ...params.result,
    deliveryState: {
      status: params.outcome.status,
      delivered,
      error,
      deliverySuppressionReason: params.deliverySuppressionReason,
      failureNotification: { status: "not-requested" },
    },
    delivered,
    deliverySuppressionReason: params.deliverySuppressionReason,
    deliveryAttempted: params.deliverySuppressionReason === undefined,
    deliveryError: error || undefined,
    delivery: {
      ...params.result.delivery,
      intended,
      delivered,
      resolved:
        delivered === undefined
          ? undefined
          : {
              to: plan.to,
              source: "explicit",
              ok: delivered,
              ...(error ? { error } : {}),
            },
    },
  };
}

export function withPrimaryWebhookInterruption(params: {
  job: CronJob;
  result: CronCoreRunOutcome;
  error: string;
  outcome?: CronWebhookDeliveryOutcome;
}): CronCoreRunOutcome {
  // Mirror deliverPrimaryWebhook's unfired-trigger gate: a trigger that
  // evaluated false never requested delivery, so an interruption must not
  // downgrade its intentional non-outcome to a delivery failure.
  return resolveCronDeliveryPlan(params.job).mode === "webhook" &&
    params.result.triggerEval?.fired !== false
    ? withPrimaryWebhookTrace({ ...params, outcome: params.outcome ?? { status: "not-delivered" } })
    : params.result;
}

export function resolveInterruptedRunProgress(params: {
  progress: CronRunProgress;
  job: CronJob;
  error: string;
}): CronCoreRunOutcome | undefined {
  if (params.progress.settledDeliveryResult) {
    return params.progress.settledDeliveryResult;
  }
  if (params.progress.completedCoreResult) {
    return withPrimaryWebhookInterruption({
      job: params.job,
      result: params.progress.completedCoreResult,
      outcome: params.progress.webhookDelivery,
      error: params.error,
    });
  }
  return undefined;
}
