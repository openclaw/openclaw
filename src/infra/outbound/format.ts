// Outbound delivery formatting produces human CLI summaries for direct and
// gateway send results.
import { findChatChannelMeta } from "../../channels/chat-meta.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import type { OutboundDeliveryResult } from "./deliver.js";

export function formatOutboundDeliverySummary(
  channel: string,
  result?: OutboundDeliveryResult,
  opts?: { action?: string },
): string {
  const action = opts?.action ?? "Sent";
  const resultChannel = result ? result.channel : channel;
  let label = getChannelPlugin(resultChannel as ChannelId)?.meta.label;
  if (!label) {
    // Some legacy chat channels are not plugins; keep their human labels for CLI output.
    const normalized = normalizeChatChannelId(resultChannel);
    label = normalized ? (findChatChannelMeta(normalized)?.label ?? resultChannel) : resultChannel;
  }
  const base = `✅ ${action} via ${label}. Message ID: ${result ? result.messageId : "unknown"}`;
  return result?.target ? `${base} (${result.target.kind} ${result.target.id})` : base;
}

export function formatGatewaySummary(params: {
  action?: string;
  channel?: string;
  messageId?: string | null;
}): string {
  const action = params.action ?? "Sent";
  const channelSuffix = params.channel ? ` (${params.channel})` : "";
  const messageId = params.messageId ?? "unknown";
  return `✅ ${action} via gateway${channelSuffix}. Message ID: ${messageId}`;
}
