import { CHAT_CHANNEL_ORDER, type ChatChannelId, normalizeChatChannelId } from "../registry.js";
import type { ChannelId, ChannelPlugin } from "./types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";

// Channel plugins registry (runtime).
//
// This module is intentionally "heavy" (plugins may import channel monitors, web login, etc).
// Shared code paths (reply flow, command auth, sandbox explain) should depend on `src/channels/dock.ts`
// instead, and only call `getChannelPlugin()` at execution boundaries.
//
// Channel plugins are registered by the plugin loader (extensions/ or configured paths).
function listPluginChannels(): ChannelPlugin[] {
  const registry = getActivePluginRegistry();
  if (!registry) return [];
  return registry.channels.map((entry) => entry.plugin);
}

function dedupeChannels(channels: ChannelPlugin[]): ChannelPlugin[] {
  const seen = new Set<string>();
  const resolved: ChannelPlugin[] = [];
  for (const plugin of channels) {
    const id = String(plugin.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    resolved.push(plugin);
  }
  return resolved;
}

export function listChannelPlugins(): ChannelPlugin[] {
  const combined = dedupeChannels(listPluginChannels());
  return combined.sort((a, b) => {
    const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id as ChatChannelId);
    const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id as ChatChannelId);
    const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
    const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const resolvedId = String(id).trim();
  if (!resolvedId) return undefined;
  return listChannelPlugins().find((plugin) => plugin.id === resolvedId);
}

export function normalizeChannelId(raw?: string | null): ChannelId | null {
  // Channel docking: keep input normalization centralized in src/channels/registry.ts
  // so CLI/API/protocol can rely on stable aliases without plugin init side effects.
  const normalized = normalizeChatChannelId(raw);
  if (normalized) return normalized;
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const key = trimmed.toLowerCase();
  const plugin = listChannelPlugins().find((entry) => {
    if (entry.id.toLowerCase() === key) return true;
    return (entry.meta.aliases ?? []).some((alias) => alias.trim().toLowerCase() === key);
  });
  return plugin?.id ?? null;
}
export {
  listDiscordDirectoryGroupsFromConfig,
  listDiscordDirectoryPeersFromConfig,
  listSlackDirectoryGroupsFromConfig,
  listSlackDirectoryPeersFromConfig,
  listTelegramDirectoryGroupsFromConfig,
  listTelegramDirectoryPeersFromConfig,
  listWhatsAppDirectoryGroupsFromConfig,
  listWhatsAppDirectoryPeersFromConfig,
} from "./directory-config.js";
export {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatch,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
  type ChannelEntryMatch,
  type ChannelMatchSource,
} from "./channel-config.js";
export {
  formatAllowlistMatchMeta,
  type AllowlistMatch,
  type AllowlistMatchSource,
} from "./allowlist-match.js";
export type { ChannelId, ChannelPlugin } from "./types.js";
