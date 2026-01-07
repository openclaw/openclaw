import type { OutboundDeliveryResult } from "./deliver.js";

export type OutboundDeliveryJson = {
  provider: string;
  via: "direct" | "gateway";
  to: string;
  messageId: string;
  mediaUrl: string | null;
  chatId?: string;
  channelId?: string;
  timestamp?: number;
  toJid?: string;
};

const resolveProviderLabel = (provider: string) =>
  provider === "imessage" ? "iMessage" : provider;

export function formatOutboundDeliverySummary(
  provider: string,
  result?: OutboundDeliveryResult,
): string {
  if (!result) {
    return `✅ Sent via ${resolveProviderLabel(provider)}. Message ID: unknown`;
  }

  const label = resolveProviderLabel(result.provider);
  const base = `✅ Sent via ${label}. Message ID: ${result.messageId}`;

  if ("chatId" in result) return `${base} (chat ${result.chatId})`;
  if ("channelId" in result) return `${base} (channel ${result.channelId})`;
  return base;
}

export function buildOutboundDeliveryJson(params: {
  provider: string;
  to: string;
  result?: OutboundDeliveryResult;
  via?: "direct" | "gateway";
  mediaUrl?: string | null;
}): OutboundDeliveryJson {
  const { provider, to, result } = params;
  const messageId = result?.messageId ?? "unknown";
  const payload: OutboundDeliveryJson = {
    provider,
    via: params.via ?? "direct",
    to,
    messageId,
    mediaUrl: params.mediaUrl ?? null,
  };

  if (result && "chatId" in result) payload.chatId = result.chatId;
  if (result && "channelId" in result) payload.channelId = result.channelId;
  if (result && "timestamp" in result && result.timestamp !== undefined) {
    payload.timestamp = result.timestamp;
  }
  if (result && "toJid" in result) payload.toJid = result.toJid;

  return payload;
}
