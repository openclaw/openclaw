import { createSourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { SourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronJob } from "../types.js";

export function resolveFallbackCronSourceDeliveryPlan(
  job: CronJob,
  resolvedDelivery: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
    ok?: boolean;
  },
): SourceDeliveryPlan {
  const deliveryPlan = resolveCronDeliveryPlan(job);
  const target = {
    channel: resolvedDelivery.channel,
    to: resolvedDelivery.to,
    accountId: resolvedDelivery.accountId,
    threadId: resolvedDelivery.threadId,
  };

  if (deliveryPlan.mode === "webhook") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_webhook",
      messageToolEnabled: false,
      directFallback: false,
    });
  }

  if (deliveryPlan.mode === "none") {
    return createSourceDeliveryPlan({
      owner: "none",
      reason: "cron_none",
      target,
      messageToolEnabled: true,
      messageToolForced: false,
      directFallback: false,
    });
  }

  return createSourceDeliveryPlan({
    owner: "direct_fallback",
    reason: "cron_announce",
    target,
    messageToolEnabled: true,
    messageToolForced: false,
    directFallback: true,
    skipFallbackWhenMessageToolSentToTarget: resolvedDelivery.ok,
  });
}
