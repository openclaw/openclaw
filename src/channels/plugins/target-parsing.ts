import { normalizeChatChannelId } from "../registry.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
import type {
  ChannelRouteParsedTarget,
  ParsedChannelExplicitTarget,
} from "./target-parsing-loaded.js";
import { resolveCompatParsedRouteTarget } from "./target-parsing-loaded.js";
export {
  comparableChannelTargetsMatch,
  comparableChannelTargetsShareRoute,
  parseExplicitTargetForLoadedChannel,
  resolveComparableTargetForLoadedChannel,
  resolveRouteTargetForLoadedChannel,
} from "./target-parsing-loaded.js";
export type {
  ComparableChannelTarget,
  ChannelRouteParsedTarget,
  ParsedChannelExplicitTarget,
} from "./target-parsing-loaded.js";

function parseWithPlugin(
  getPlugin: (channel: string) => ReturnType<typeof getChannelPlugin>,
  rawChannel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId(rawChannel);
  if (!channel) {
    return null;
  }
  return getPlugin(channel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}

/** @deprecated Use `messaging.targetResolver` and `messaging.resolveOutboundSessionRoute`. */
export function parseExplicitTargetForChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  return parseWithPlugin(getChannelPlugin, channel, rawTarget);
}

/** @deprecated Use `messaging.resolveOutboundSessionRoute` for provider-specific target grammar. */
export function resolveRouteTargetForChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  return resolveCompatParsedRouteTarget({
    ...params,
    parseTarget: parseExplicitTargetForChannel,
  });
}

/** @deprecated Use `messaging.resolveOutboundSessionRoute` for provider-specific target grammar. */
export function resolveComparableTargetForChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  return resolveRouteTargetForChannel(params);
}
