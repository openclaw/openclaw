import type { AnyChannelPlugin as ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.public.js";
import { getRuntimeVisibleChannelPlugin } from "./runtime-visible-channels.js";
import { stripProviderTargetPrefixes, stripTargetPrefixes } from "./target-resolution-results.js";

function detectTypedTargetKind(raw: string): ChannelDirectoryEntryKind | undefined {
  if (/^user:/i.test(raw)) {
    return "user";
  }
  if (/^channel:/i.test(raw)) {
    return "channel";
  }
  if (/^group:/i.test(raw)) {
    return "group";
  }
  return undefined;
}

function detectExplicitTargetKind(
  channel: ChannelId,
  raw: string,
  plugin?: ChannelPlugin,
): ChannelDirectoryEntryKind | undefined {
  const trimmed = stripProviderTargetPrefixes(raw, channel, plugin);
  const typedKind = detectTypedTargetKind(trimmed);
  if (typedKind) {
    return typedKind;
  }
  if (trimmed.startsWith("@") || /^<@!?/.test(trimmed)) {
    return "user";
  }
  if (trimmed.startsWith("#")) {
    return "group";
  }
  return undefined;
}

function inferTargetKind(
  channel: ChannelId,
  raw: string,
  plugin?: ChannelPlugin,
): ChannelDirectoryEntryKind | undefined {
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
  return undefined;
}

function defaultTargetKind(plugin?: ChannelPlugin): ChannelDirectoryEntryKind {
  const chatTypes = plugin?.capabilities?.chatTypes ?? [];
  return chatTypes.length > 0 && chatTypes.every((chatType) => chatType === "direct")
    ? "user"
    : "group";
}

export function detectTargetKind(
  channel: ChannelId,
  raw: string,
  preferred?: ChannelDirectoryEntryKind,
  plugin?: ChannelPlugin,
): ChannelDirectoryEntryKind {
  if (preferred) {
    return preferred;
  }
  return (
    inferTargetKind(channel, raw, plugin) ??
    detectExplicitTargetKind(channel, raw, plugin) ??
    defaultTargetKind(plugin)
  );
}

export function classifyRewrittenTarget(params: {
  channel: ChannelId;
  originalTo: string;
  originalKind: ChannelDirectoryEntryKind;
  originalKindIsResolved?: boolean;
  resolvedTo: string;
  plugin?: ChannelPlugin;
}): ChannelDirectoryEntryKind {
  if (params.originalTo.trim() === params.resolvedTo.trim()) {
    return params.originalKind;
  }
  const explicitKind = detectExplicitTargetKind(params.channel, params.resolvedTo, params.plugin);
  const typedKind = detectTypedTargetKind(
    stripProviderTargetPrefixes(params.resolvedTo, params.channel, params.plugin),
  );
  const originalIdentity = stripTargetPrefixes(params.originalTo, params.channel, params.plugin);
  const resolvedIdentity = stripTargetPrefixes(params.resolvedTo, params.channel, params.plugin);
  if (originalIdentity && originalIdentity === resolvedIdentity) {
    // Typed routing changes the recipient kind; handle/provider spelling alone
    // cannot weaken a confirmed kind for the same native identity.
    const originalExplicitKind = detectExplicitTargetKind(
      params.channel,
      params.originalTo,
      params.plugin,
    );
    const originalTypedKind = detectTypedTargetKind(
      stripProviderTargetPrefixes(params.originalTo, params.channel, params.plugin),
    );
    if (typedKind && typedKind !== originalTypedKind) {
      return typedKind;
    }
    if (params.originalKindIsResolved || params.originalKind === "user") {
      return params.originalKind;
    }
    if (inferTargetKind(params.channel, params.resolvedTo, params.plugin) === "user") {
      return "user";
    }
    if (inferTargetKind(params.channel, params.originalTo, params.plugin) === params.originalKind) {
      return params.originalKind;
    }
    return explicitKind && explicitKind !== originalExplicitKind
      ? explicitKind
      : params.originalKind;
  }
  const inferredKind = typedKind
    ? undefined
    : inferTargetKind(params.channel, params.resolvedTo, params.plugin);
  const rewrittenKind =
    typedKind ?? inferredKind ?? explicitKind ?? defaultTargetKind(params.plugin);
  if (
    params.originalKindIsResolved &&
    params.originalKind === "user" &&
    rewrittenKind !== "user" &&
    !typedKind &&
    explicitKind !== "group" &&
    explicitKind !== "channel"
  ) {
    const originalInferredKind = inferTargetKind(params.channel, params.originalTo, params.plugin);
    // A classifier that cannot identify this known peer cannot use its grouping
    // fallback to turn an opaque rewrite into an allowed group delivery.
    if (!inferredKind || (originalInferredKind && originalInferredKind !== "user")) {
      return "user";
    }
  }
  return rewrittenKind;
}
