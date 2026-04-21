import { normalizeChatChannelId } from "../registry.js";
import { getChannelPlugin, normalizeChannelId } from "./index.js";
export {
  comparableChannelTargetsMatch,
  comparableChannelTargetsShareRoute,
  parseExplicitTargetForLoadedChannel,
  resolveComparableTargetForLoadedChannel,
  resolveCurrentChannelTargetFromMessaging,
} from "./target-parsing-loaded.js";
export type {
  ComparableChannelTarget,
  ParsedChannelExplicitTarget,
} from "./target-parsing-loaded.js";
import {
  resolveComparableChannelTarget,
  resolveParsedChannelTarget,
  type ComparableChannelTarget,
  type ParsedChannelExplicitTarget,
} from "./target-parsing-shared.js";

function resolveChannelMessaging(rawChannel: string) {
  const channel = normalizeChatChannelId(rawChannel) ?? normalizeChannelId(rawChannel);
  if (!channel) {
    return undefined;
  }
  return getChannelPlugin(channel)?.messaging;
}

export function parseExplicitTargetForChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  return resolveParsedChannelTarget({
    rawTarget,
    messaging: resolveChannelMessaging(channel),
  }).parsedTarget;
}

export function resolveComparableTargetForChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ComparableChannelTarget | null {
  return resolveComparableChannelTarget({
    rawTarget: params.rawTarget,
    fallbackThreadId: params.fallbackThreadId,
    messaging: resolveChannelMessaging(params.channel),
  });
}
