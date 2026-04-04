import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";

export function extractExplicitGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  if (parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")) {
    const joined = parts.slice(2).join(":");
    return joined.replace(/:topic:.*$/, "") || undefined;
  }
  if (parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")) {
    const joined = parts.slice(1).join(":");
    return joined.replace(/:topic:.*$/, "") || undefined;
  }
  const channelId = normalizeChannelId(parts[0] ?? "") ?? parts[0]?.trim().toLowerCase();
  const parsed = channelId
    ? getChannelPlugin(channelId)?.messaging?.parseExplicitTarget?.({ raw: trimmed })
    : null;
  if (parsed && parsed.chatType && parsed.chatType !== "direct") {
    return parsed.to.replace(/:topic:.*$/, "") || undefined;
  }
  return undefined;
}
