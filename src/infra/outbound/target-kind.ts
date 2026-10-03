import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";
import { stripProviderTargetPrefixes, stripTargetPrefixes } from "./target-resolution-results.js";

export type TargetResolveKind = ChannelDirectoryEntryKind | "channel";

function detectSemanticTargetKind(
  channel: ChannelId,
  raw: string,
  plugin?: ChannelPlugin,
): TargetResolveKind | undefined {
  const trimmed = stripProviderTargetPrefixes(raw, channel, plugin);
  if (/^user:/i.test(trimmed)) {
    return "user";
  }
  if (/^channel:/i.test(trimmed)) {
    return "channel";
  }
  if (/^group:/i.test(trimmed)) {
    return "group";
  }
  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed)) {
    return "user";
  }
  if (trimmed.startsWith("#")) {
    return "group";
  }

  const inferredChatType = (
    plugin ?? getRuntimeVisibleChannelPlugin(channel)
  )?.messaging?.inferTargetChatType?.({ to: raw });
  if (inferredChatType === "direct") {
    return "user";
  }
  if (inferredChatType === "channel") {
    return "channel";
  }
  if (inferredChatType === "group") {
    return "group";
  }

  const chatTypes = plugin?.capabilities?.chatTypes ?? [];
  if (chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct")) {
    return "user";
  }
  return undefined;
}

export function detectTargetKind(
  channel: ChannelId,
  raw: string,
  preferred?: TargetResolveKind,
  plugin?: ChannelPlugin,
): TargetResolveKind {
  if (preferred) {
    return preferred;
  }
  return detectSemanticTargetKind(channel, raw, plugin) ?? "group";
}

export function classifyRewrittenTarget(params: {
  channel: ChannelId;
  originalTo: string;
  originalKind: TargetResolveKind;
  resolvedTo: string;
  plugin?: ChannelPlugin;
}): TargetResolveKind {
  if (params.originalTo.trim() === params.resolvedTo.trim()) {
    return params.originalKind;
  }
  const semanticKind = detectSemanticTargetKind(params.channel, params.resolvedTo, params.plugin);
  if (semanticKind) {
    return semanticKind;
  }
  const originalIdentity = normalizeLowercaseStringOrEmpty(
    stripTargetPrefixes(params.originalTo, params.channel, params.plugin),
  );
  const resolvedIdentity = normalizeLowercaseStringOrEmpty(
    stripTargetPrefixes(params.resolvedTo, params.channel, params.plugin),
  );
  if (originalIdentity && originalIdentity === resolvedIdentity) {
    return params.originalKind;
  }
  return detectTargetKind(params.channel, params.resolvedTo, undefined, params.plugin);
}
