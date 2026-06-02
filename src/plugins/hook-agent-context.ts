import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseRawSessionConversationRef } from "../sessions/session-key-utils.js";
import type { PluginHookAgentContext } from "./hook-types.js";

const TARGET_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

function normalizeKey(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function stripConversationPrefix(
  value: string | undefined,
  ...providers: Array<string | undefined>
): string | undefined {
  const text = normalizeOptionalString(value);
  if (!text) {
    return undefined;
  }

  const separatorIndex = text.indexOf(":");
  if (separatorIndex === -1) {
    return text;
  }

  const prefix = normalizeKey(text.slice(0, separatorIndex));
  const suffix = normalizeOptionalString(text.slice(separatorIndex + 1));
  if (!suffix) {
    return text;
  }
  // Hook consumers expect the concrete conversation/channel id, not transport prefixes like
  // `dm:` or provider-qualified ids copied from routing metadata.
  if (
    TARGET_PREFIXES.has(prefix) ||
    providers.some((provider) => prefix === normalizeKey(provider))
  ) {
    return suffix;
  }
  return text;
}

/** Resolves the channel id exposed to plugin agent hooks from session and routing metadata. */
export function resolveAgentHookChannelId(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): string | undefined {
  const provider = normalizeOptionalString(params.messageProvider);
  const messageChannel = normalizeOptionalString(params.messageChannel);
  const parsed = parseRawSessionConversationRef(params.sessionKey);
  // Session keys are the most precise source: they already encode the raw conversation id
  // that follow-up turns should expose to plugins.
  if (parsed?.rawId) {
    return parsed.rawId;
  }

  const metadataChannel =
    stripConversationPrefix(params.currentChannelId ?? undefined, provider, messageChannel) ??
    stripConversationPrefix(params.messageTo ?? undefined, provider, messageChannel);
  if (metadataChannel && normalizeKey(metadataChannel) !== normalizeKey(provider)) {
    return metadataChannel;
  }

  const strippedMessageChannel = stripConversationPrefix(
    params.messageChannel ?? undefined,
    provider,
    messageChannel,
  );
  if (strippedMessageChannel && normalizeKey(strippedMessageChannel) !== normalizeKey(provider)) {
    return strippedMessageChannel;
  }
  return messageChannel ?? provider;
}

/** Builds the channel-related fields shared by plugin hook agent contexts. */
export function buildAgentHookContextChannelFields(params: {
  sessionKey?: string | null;
  messageChannel?: string | null;
  messageProvider?: string | null;
  currentChannelId?: string | null;
  messageTo?: string | null;
}): Pick<PluginHookAgentContext, "channelId" | "messageProvider"> {
  return {
    messageProvider: normalizeOptionalString(params.messageProvider),
    channelId: resolveAgentHookChannelId(params),
  };
}
