import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";

export type SourceDeliveryTarget = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

export type SourceDeliveryMessageToolTarget = {
  tool?: string;
  provider?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
  threadImplicit?: boolean;
  threadSuppressed?: boolean;
  text?: string;
  mediaUrls?: string[];
};

function normalizeDeliveryTarget(to: string, plugin?: ChannelPlugin): string {
  return normalizeOptionalString(plugin?.messaging?.normalizeTarget?.(to) ?? to) ?? to.trim();
}

function deliveryTargetsMatch(
  targetTo: string,
  deliveryTo: string,
  plugin?: ChannelPlugin,
): boolean {
  const targetPrefixed = targetTo.trim().match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const deliveryPrefixed = deliveryTo.trim().match(/^([a-z][a-z0-9_-]*):(.*)$/i);
  const targetKind = targetPrefixed?.[1]?.toLowerCase();
  const deliveryKind = deliveryPrefixed?.[1]?.toLowerCase();
  if (
    targetKind &&
    targetKind === deliveryKind &&
    ["channel", "conversation", "group", "user"].includes(targetKind)
  ) {
    const targetId = targetPrefixed?.[2]?.trim();
    const deliveryId = deliveryPrefixed?.[2]?.trim();
    const comparison = plugin?.messaging?.targetIdComparison;
    if (comparison === "case-sensitive") {
      return targetId === deliveryId;
    }
    if (comparison === "lowercase") {
      return targetId?.toLowerCase() === deliveryId?.toLowerCase();
    }
  }
  return normalizeDeliveryTarget(targetTo, plugin) === normalizeDeliveryTarget(deliveryTo, plugin);
}

function normalizeDeliveryThreadId(threadId: string | number | undefined): string | undefined {
  return stringifyRouteThreadId(threadId)?.trim() || undefined;
}

const TOPIC_THREAD_SUFFIX = /:topic:(\d+)$/i;

export function matchSourceDeliveryTargetWithPlugin(
  target: SourceDeliveryMessageToolTarget,
  delivery: SourceDeliveryTarget,
  plugin?: ChannelPlugin,
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
      targetTopic ? targetTo.slice(0, targetTopic.index) : targetTo,
      deliveryTopic ? deliveryTo.slice(0, deliveryTopic.index) : deliveryTo,
      plugin,
    )
  ) {
    return false;
  }
  const deliveryThreadId = normalizeDeliveryThreadId(delivery.threadId) ?? deliveryTopic?.[1];
  const targetThreadId = normalizeDeliveryThreadId(target.threadId) ?? targetTopic?.[1];
  if (!deliveryThreadId && !targetThreadId) {
    return true;
  }
  if (deliveryThreadId && !targetThreadId) {
    return target.threadImplicit === true && target.threadSuppressed !== true;
  }
  return deliveryThreadId === targetThreadId;
}
