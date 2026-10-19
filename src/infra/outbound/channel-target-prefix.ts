import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMessageChannel } from "../../utils/message-channel-core.js";
import { listRuntimeVisibleChannelPlugins } from "./runtime-visible-channels.js";

const TARGET_KIND_PREFIXES: readonly string[] = [
  "channel",
  "conversation",
  "dm",
  "group",
  "room",
  "thread",
  "user",
];
const TARGET_KIND_PATTERN = new RegExp(`^(${TARGET_KIND_PREFIXES.join("|")}):`, "i");

/** Removes a selected channel/provider prefix from an outbound target string. */
export function stripTargetProviderPrefix(raw: string, ...providers: string[]): string {
  const trimmed = raw.trim();
  const lower = normalizeOptionalLowercaseString(trimmed) ?? "";
  for (const provider of providers) {
    const normalizedProvider = normalizeOptionalLowercaseString(provider);
    if (normalizedProvider && lower.startsWith(`${normalizedProvider}:`)) {
      return trimmed.slice(normalizedProvider.length + 1).trim();
    }
  }
  return trimmed;
}

/** Removes generic target-kind prefixes such as room:, thread:, or user:. */
export function stripOutboundTargetKindPrefix(
  raw: string,
  kinds: readonly string[] = TARGET_KIND_PREFIXES,
): string {
  if (kinds === TARGET_KIND_PREFIXES) {
    return raw.replace(TARGET_KIND_PATTERN, "").trim();
  }
  const kindPattern = kinds
    .map((kind) => normalizeOptionalLowercaseString(kind))
    .filter((kind): kind is string => Boolean(kind))
    .join("|");
  return kindPattern ? raw.replace(new RegExp(`^(${kindPattern}):`, "i"), "").trim() : raw.trim();
}

/** Strips plugin topic suffixes while preserving ordinary colon-containing targets. */
export function stripTargetTopicSuffix(
  raw: string,
  options: { allowNumericShorthand?: boolean } = {},
): string {
  const trimmed = raw.trim();
  const numericTopicMatch = options.allowNumericShorthand ? /^(-?\d+):(\d+)$/.exec(trimmed) : null;
  return numericTopicMatch?.[1] ?? trimmed.replace(/:topic:.*$/i, "").trim();
}

function resolveChannelTargetProviderPrefix(
  raw?: string | null,
): { prefix: string; channel: string } | undefined {
  const match = /^\s*([a-z][a-z0-9_-]*):/i.exec(raw ?? "");
  const prefix = normalizeOptionalLowercaseString(match?.[1]);
  if (!prefix || TARGET_KIND_PREFIXES.includes(prefix)) {
    return undefined;
  }
  for (const plugin of listRuntimeVisibleChannelPlugins()) {
    const channelId = normalizeOptionalLowercaseString(plugin.id);
    const candidates = plugin.messaging?.targetPrefixes ?? [];
    if (
      channelId &&
      candidates.some((candidate) => normalizeOptionalLowercaseString(candidate) === prefix)
    ) {
      return { prefix, channel: channelId };
    }
  }
  return undefined;
}

/** Resolves the channel implied by a plugin-owned target prefix, if any. */
export function resolveTargetPrefixedChannel(raw?: string | null): string | undefined {
  return resolveChannelTargetProviderPrefix(raw)?.channel;
}

/** Rejects targets whose plugin-owned prefix belongs to a different selected channel. */
export function validateTargetProviderPrefix(params: {
  channel: string;
  to?: string | null;
}): Error | undefined {
  const selectedChannel =
    normalizeMessageChannel(params.channel) ?? normalizeOptionalLowercaseString(params.channel);
  if (!selectedChannel || selectedChannel === "last") {
    return undefined;
  }
  const prefixed = resolveChannelTargetProviderPrefix(params.to);
  if (!prefixed || prefixed.channel === selectedChannel) {
    return undefined;
  }
  return new Error(
    `Target prefix "${prefixed.prefix}:" belongs to ${prefixed.channel}, not ${selectedChannel}.`,
  );
}
