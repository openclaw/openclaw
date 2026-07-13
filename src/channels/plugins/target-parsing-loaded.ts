/**
 * Loaded-channel target parsing helpers.
 *
 * Bridges deprecated explicit target parsing with modern channel route target helpers.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { ChannelRouteParsedTarget } from "../../plugin-sdk/channel-route.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded.js";

/** @deprecated Use `ChannelRouteParsedTarget`; provider-specific target grammar should live in `messaging.resolveOutboundSessionRoute`. */
type ParsedChannelExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: "direct" | "group" | "channel";
};

function resolveCompatParsedRouteTarget(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
  parseTarget: (channel: string, rawTarget: string) => ParsedChannelExplicitTarget | null;
}): ChannelRouteParsedTarget | null {
  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const rawTo = normalizeOptionalString(params.rawTarget);
  if (!channel || !rawTo) {
    return null;
  }
  const parsed = params.parseTarget(channel, rawTo);
  const fallbackThreadId = normalizeOptionalThreadValue(params.fallbackThreadId);
  return {
    channel,
    rawTo,
    to: parsed?.to ?? rawTo,
    threadId: normalizeOptionalThreadValue(parsed?.threadId ?? fallbackThreadId),
    chatType: parsed?.chatType,
  };
}

/** @deprecated Use `messaging.targetResolver` and `messaging.resolveOutboundSessionRoute`. */
function parseExplicitTargetForLoadedChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  const resolvedChannel = normalizeOptionalString(channel);
  if (!resolvedChannel) {
    return null;
  }
  const normalizedChannel = normalizeChannelId(resolvedChannel) ?? resolvedChannel;
  return (
    getLoadedChannelPluginForRead(normalizedChannel)?.messaging?.parseExplicitTarget?.({
      raw: rawTarget,
    }) ??
    getChannelPlugin(normalizedChannel)?.messaging?.parseExplicitTarget?.({
      raw: rawTarget,
    }) ??
    null
  );
}

/** @deprecated Use `messaging.resolveOutboundSessionRoute` for provider-specific target grammar. */
function resolveRouteTargetForLoadedChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  return resolveCompatParsedRouteTarget({
    ...params,
    parseTarget: parseExplicitTargetForLoadedChannel,
  });
}

export function resolveExplicitDeliveryTargetCompat(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  return resolveRouteTargetForLoadedChannel(params);
}
