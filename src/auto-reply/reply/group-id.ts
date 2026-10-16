/** Extracts group/channel ids from explicit message targets. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../../channels/registry.js";
import {
  stripOutboundTargetKindPrefix,
  stripTargetProviderPrefix,
  stripTargetTopicSuffix,
} from "../../infra/outbound/channel-target-prefix.js";

/** Extracts a group/channel target id from explicit channel target syntax. */
export function extractExplicitGroupId(raw: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  const idStart =
    parts.length >= 3 && (parts[1] === "group" || parts[1] === "channel")
      ? 2
      : parts.length >= 2 && (parts[0] === "group" || parts[0] === "channel")
        ? 1
        : undefined;
  const simple =
    idStart === undefined
      ? undefined
      : parts
          .slice(idStart)
          .join(":")
          .replace(/:topic:.*$/, "");
  if (simple) {
    return simple;
  }
  const firstPart = parts[0];
  const channelId =
    normalizeAnyChannelId(firstPart ?? "") ?? normalizeOptionalLowercaseString(firstPart);
  const messaging = channelId ? getLoadedChannelPluginForRead(channelId)?.messaging : undefined;
  if (!channelId) {
    return undefined;
  }
  const normalized = messaging?.normalizeTarget?.(trimmed);
  const candidates = uniqueStrings(
    [normalized, trimmed].filter((candidate): candidate is string => Boolean(candidate)),
  );
  for (const candidate of candidates) {
    const chatType = messaging?.inferTargetChatType?.({ to: candidate });
    if (chatType === "direct" || chatType == null) {
      continue;
    }
    const target = stripTargetTopicSuffix(
      stripOutboundTargetKindPrefix(stripTargetProviderPrefix(candidate, channelId), [
        "group",
        "channel",
        "conversation",
        "room",
        "thread",
      ]),
      { allowNumericShorthand: messaging?.numericTopicShorthand === true },
    );
    if (target) {
      return target;
    }
  }
  return undefined;
}
