import { getBundledChannelPlugin } from "../../channels/plugins/bundled.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export function extractExplicitGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(raw) ?? "";
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
  if (parts.length >= 2 && parts[0] === "whatsapp") {
    const joined = parts
      .slice(1)
      .join(":")
      .replace(/:topic:.*$/, "");
    if (/@g\.us$/i.test(joined)) {
      return joined || undefined;
    }
  }
  const channelId =
    normalizeChannelId(parts[0] ?? "") ?? normalizeOptionalLowercaseString(parts[0]);
  const messaging = channelId
    ? (getLoadedChannelPlugin(channelId)?.messaging ??
      getBundledChannelPlugin(channelId)?.messaging)
    : undefined;
  const parsed = messaging?.parseExplicitTarget?.({ raw: trimmed }) ?? null;
  if (parsed && parsed.chatType && parsed.chatType !== "direct") {
    return parsed.to.replace(/:topic:.*$/, "") || undefined;
  }
  return undefined;
}
