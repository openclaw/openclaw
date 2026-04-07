// Keep built-in channel IDs in a leaf module so shared config/sandbox code can
// reference them without importing channel registry helpers that may pull in
// plugin runtime state.
//
// NOTE: This module should remain a leaf (zero heavy imports). If you need
// channel metadata, import from channels/registry.ts instead.
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
  "line",
] as const;

export type ChatChannelId = (typeof CHAT_CHANNEL_ORDER)[number];

export const CHANNEL_IDS = [...CHAT_CHANNEL_ORDER] as const;

// Built-in aliases for common channel name variations.
// These are hardcoded to keep ids.ts a leaf module with zero heavy imports.
const BUILT_IN_CHAT_CHANNEL_ALIAS_ENTRIES = [
  ["gchat", "googlechat"],
  ["google-chat", "googlechat"],
  ["imsg", "imessage"],
  ["internet-relay-chat", "irc"],
] as const satisfies ReadonlyArray<readonly [string, ChatChannelId]>;

export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = Object.freeze(
  Object.fromEntries(BUILT_IN_CHAT_CHANNEL_ALIAS_ENTRIES),
) as Record<string, ChatChannelId>;

function normalizeChannelKey(raw?: string | null): string | undefined {
  const normalized = raw?.trim().toLowerCase();
  return normalized || undefined;
}

export function listChatChannelAliases(): string[] {
  return Object.keys(CHAT_CHANNEL_ALIASES);
}

export function normalizeChatChannelId(raw?: string | null): ChatChannelId | null {
  const normalized = normalizeChannelKey(raw);
  if (!normalized) {
    return null;
  }
  const resolved = CHAT_CHANNEL_ALIASES[normalized] ?? normalized;
  return CHAT_CHANNEL_ORDER.includes(resolved) ? resolved : null;
}
