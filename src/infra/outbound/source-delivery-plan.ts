// Source-delivery plans decide whether final output is visible through the
// message tool, direct fallback delivery, both, or neither.
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import type {
  SourceDeliveryMessageToolTarget,
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
  SourceDeliveryTarget,
} from "./source-delivery-plan.types.js";
import { normalizeTargetForProvider } from "./target-normalization.js";
export type {
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
  SourceDeliveryVisibleDelivery,
} from "./source-delivery-plan.types.js";

function normalizeDeliveryTarget(channel: string, to: string): string {
  const toTrimmed = to.trim();
  return normalizeTargetForProvider(channel, toTrimmed) ?? toTrimmed;
}

function deliveryTargetsMatch(channel: string, targetTo: string, deliveryTo: string): boolean {
  const targetToTrimmed = targetTo.trim();
  const deliveryToTrimmed = deliveryTo.trim();
  if (targetToTrimmed === deliveryToTrimmed) {
    return true;
  }
  const targetPrefixed = targetToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const deliveryPrefixed = deliveryToTrimmed.match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const targetKind = targetPrefixed?.[1]?.toLowerCase();
  const deliveryKind = deliveryPrefixed?.[1]?.toLowerCase();
  if (
    targetKind &&
    targetKind === deliveryKind &&
    ["channel", "conversation", "group", "user"].includes(targetKind)
  ) {
    // Provider-owned ID comparison can bypass generic target normalization.
    const targetId = targetPrefixed?.[2]?.trim();
    const deliveryId = deliveryPrefixed?.[2]?.trim();
    const comparison = getChannelPlugin(channel)?.messaging?.targetIdComparison;
    if (comparison === "case-sensitive") {
      return targetId === deliveryId;
    }
    if (comparison === "lowercase") {
      return targetId?.toLowerCase() === deliveryId?.toLowerCase();
    }
  }
  return (
    normalizeDeliveryTarget(channel, targetToTrimmed) ===
    normalizeDeliveryTarget(channel, deliveryToTrimmed)
  );
}

const TOPIC_THREAD_SUFFIX = /:topic:(\d+)$/i;

/** Compares a message-tool target with the required source delivery target. */
export function sourceDeliveryTargetsMatch(
  target: SourceDeliveryMessageToolTarget,
  delivery: SourceDeliveryTarget,
): boolean {
  if (!delivery.channel || !delivery.to || !target.to) {
    return false;
  }
  const channel = delivery.channel.trim().toLowerCase();
  const provider = target.provider?.trim().toLowerCase();
  if (provider && provider !== "message" && provider !== channel) {
    return false;
  }
  if (delivery.accountId && target.accountId && target.accountId !== delivery.accountId) {
    return false;
  }
  const targetTo = target.to.trim();
  const deliveryTo = delivery.to.trim();
  const targetTopic = TOPIC_THREAD_SUFFIX.exec(targetTo);
  const deliveryTopic = TOPIC_THREAD_SUFFIX.exec(deliveryTo);
  if (
    !deliveryTargetsMatch(
      channel,
      targetTopic ? targetTo.slice(0, targetTopic.index) : targetTo,
      deliveryTopic ? deliveryTo.slice(0, deliveryTopic.index) : deliveryTo,
    )
  ) {
    return false;
  }
  const deliveryThreadId = stringifyRouteThreadId(delivery.threadId) ?? deliveryTopic?.[1];
  const targetThreadId = stringifyRouteThreadId(target.threadId) ?? targetTopic?.[1];
  if (!deliveryThreadId && !targetThreadId) {
    return true;
  }
  if (deliveryThreadId && !targetThreadId) {
    return target.threadImplicit === true && target.threadSuppressed !== true;
  }
  return deliveryThreadId === targetThreadId;
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
