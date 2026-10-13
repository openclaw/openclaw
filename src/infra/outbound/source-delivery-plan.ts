// Source-delivery plans decide whether final output is visible through the
// message tool, direct fallback delivery, both, or neither.
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import {
  matchSourceDeliveryTargetWithPlugin,
  type SourceDeliveryMessageToolTarget,
  type SourceDeliveryTarget,
} from "./source-delivery-target-match.js";

/** Owner responsible for making source delivery visible to the user. */
type SourceVisibleDeliveryOwner =
  | "automatic_source"
  | "message_tool"
  | "message_tool_then_direct_fallback"
  | "direct_fallback"
  | "none";

/** Reason code explaining why source delivery policy took this shape. */
type SourceDeliveryPlanReason =
  | "config"
  | "room_event"
  | "cron_announce"
  | "cron_webhook"
  | "cron_none"
  | "media_completion"
  | "subagent_completion";

/** Visible message-tool delivery with target verification state. */
export type SourceDeliveryVisibleDelivery = {
  via: "message_tool";
  target: SourceDeliveryMessageToolTarget;
  verifiedTarget: boolean;
};

/** Resolved source-delivery satisfaction result after a run. */
export type SourceDeliveryOutcome = {
  visibleDeliveries: SourceDeliveryVisibleDelivery[];
  verifiedMessageToolDelivery: boolean;
  satisfiesSourceDelivery: boolean;
  unverifiedMessageToolDelivery: boolean;
};

/** Policy contract that decides message-tool ownership and fallback delivery. */
export type SourceDeliveryPlan = {
  owner: SourceVisibleDeliveryOwner;
  reason: SourceDeliveryPlanReason;
  target: SourceDeliveryTarget;
  normalFinal: "visible" | "private";
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  messageTool: {
    enabled: boolean;
    force: boolean;
    requireExplicitTarget: boolean;
    requireExplicitTargetEvidence: boolean;
  };
  fallback: {
    directDelivery: boolean;
    skipWhenMessageToolSentToTarget: boolean;
  };
};

/** Compares a message-tool target with the required source delivery target. */
export function sourceDeliveryTargetsMatch(
  target: SourceDeliveryMessageToolTarget,
  delivery: SourceDeliveryTarget,
): boolean {
  const channel = delivery.channel?.trim().toLowerCase();
  return channel
    ? matchSourceDeliveryTargetWithPlugin(target, delivery, getChannelPlugin(channel))
    : false;
}

/** Evaluates whether observed message-tool sends satisfy the source delivery plan. */
export function resolveSourceDeliveryOutcome(
  plan: SourceDeliveryPlan,
  params: {
    didSendViaMessageTool?: boolean;
    messageToolSentTargets?: SourceDeliveryMessageToolTarget[];
  },
): SourceDeliveryOutcome {
  const didSendViaMessageTool = params.didSendViaMessageTool === true;
  let sentTargets = params.messageToolSentTargets ?? [];
  // Cron completion accounting needs concrete target evidence. Legacy
  // message-tool-owned flows may still use the plan target as the implicit send.
  if (
    sentTargets.length === 0 &&
    didSendViaMessageTool &&
    !plan.messageTool.requireExplicitTargetEvidence &&
    plan.target.channel &&
    plan.target.to
  ) {
    const threadId = stringifyRouteThreadId(plan.target.threadId);
    sentTargets = [
      {
        tool: "message",
        provider: plan.target.channel,
        ...(plan.target.accountId ? { accountId: plan.target.accountId } : {}),
        to: plan.target.to,
        ...(threadId ? { threadId } : {}),
      },
    ];
  }
  const visibleDeliveries = sentTargets.map((target) => ({
    via: "message_tool" as const,
    target,
    verifiedTarget: sourceDeliveryTargetsMatch(target, plan.target),
  }));
  const hasVerifiedMessageToolDelivery = visibleDeliveries.some(
    (delivery) => didSendViaMessageTool && delivery.verifiedTarget,
  );
  return {
    visibleDeliveries,
    verifiedMessageToolDelivery: hasVerifiedMessageToolDelivery,
    satisfiesSourceDelivery:
      plan.fallback.skipWhenMessageToolSentToTarget && hasVerifiedMessageToolDelivery,
    unverifiedMessageToolDelivery:
      didSendViaMessageTool && sentTargets.length > 0 && !hasVerifiedMessageToolDelivery,
  };
}
