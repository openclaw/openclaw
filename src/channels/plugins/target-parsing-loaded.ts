import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";
export {
  comparableChannelTargetsMatch,
  comparableChannelTargetsShareRoute,
  resolveComparableChannelTarget,
  resolveCurrentChannelTargetFromMessaging,
  resolveParsedChannelTarget,
} from "./target-parsing-shared.js";
export type {
  ChannelTargetParsingMessaging,
  ComparableChannelTarget,
  ParsedChannelExplicitTarget,
} from "./target-parsing-shared.js";
import {
  resolveComparableChannelTarget,
  resolveParsedChannelTarget,
  type ComparableChannelTarget,
  type ParsedChannelExplicitTarget,
} from "./target-parsing-shared.js";

export function parseExplicitTargetForLoadedChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  const resolvedChannel = normalizeOptionalString(channel);
  if (!resolvedChannel) {
    return null;
  }
  return resolveParsedChannelTarget({
    rawTarget,
    messaging: getLoadedChannelPluginForRead(resolvedChannel)?.messaging,
  }).parsedTarget;
}

export function resolveComparableTargetForLoadedChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ComparableChannelTarget | null {
  const resolvedChannel = normalizeOptionalString(params.channel);
  if (!resolvedChannel) {
    return null;
  }
  return resolveComparableChannelTarget({
    rawTarget: params.rawTarget,
    fallbackThreadId: params.fallbackThreadId,
    messaging: getLoadedChannelPluginForRead(resolvedChannel)?.messaging,
  });
}
