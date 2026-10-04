import type { SourceDeliveryPlan } from "../../infra/outbound/source-delivery-plan.js";
import type { CronDeliveryPlan } from "../delivery-plan.js";

export function resolveCronSourceDeliveryPlan(params: {
  deliveryPlan: CronDeliveryPlan;
  resolvedDelivery: SourceDeliveryPlan["target"] & { ok?: boolean };
}): SourceDeliveryPlan {
  const webhook = params.deliveryPlan.mode === "webhook";
  const announce = !webhook && params.deliveryPlan.mode !== "none";
  return {
    owner: announce ? "direct_fallback" : "none",
    reason: announce ? "cron_announce" : webhook ? "cron_webhook" : "cron_none",
    target: webhook
      ? {}
      : {
          channel: params.resolvedDelivery.channel,
          to: params.resolvedDelivery.to,
          accountId: params.resolvedDelivery.accountId,
          threadId: params.resolvedDelivery.threadId,
        },
    normalFinal: announce ? "visible" : "private",
    sourceReplyDeliveryMode: undefined,
    messageTool: {
      enabled: !webhook,
      force: false,
      requireExplicitTarget: announce,
      requireExplicitTargetEvidence: announce,
    },
    fallback: {
      directDelivery: announce,
      skipWhenMessageToolSentToTarget: announce && (params.resolvedDelivery.ok ?? true),
    },
  };
}
