import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { CHAT_CHANNEL_ORDER, normalizeAnyChannelId } from "../registry.js";
// Channel plugins registry (runtime).
//
// This module is intentionally "heavy" (plugins may import channel monitors, web login, etc).
// Shared code paths (reply flow, command auth, sandbox explain) should depend on `src/channels/dock.ts`
// instead, and only call `getChannelPlugin()` at execution boundaries.
//
// Channel plugins are registered by the plugin loader (extensions/ or configured paths).
function listPluginChannels() {
    const registry = requireActivePluginRegistry();
    return registry.channels.map((entry) => entry.plugin);
}
function dedupeChannels(channels) {
    const seen = new Set();
    const resolved = [];
    for (const plugin of channels) {
        const id = String(plugin.id).trim();
        if (!id || seen.has(id)) {
            continue;
        }
        seen.add(id);
        resolved.push(plugin);
    }
    return resolved;
}
export function listChannelPlugins() {
    const combined = dedupeChannels(listPluginChannels());
    return combined.toSorted((a, b) => {
        const indexA = CHAT_CHANNEL_ORDER.indexOf(a.id);
        const indexB = CHAT_CHANNEL_ORDER.indexOf(b.id);
        const orderA = a.meta.order ?? (indexA === -1 ? 999 : indexA);
        const orderB = b.meta.order ?? (indexB === -1 ? 999 : indexB);
        if (orderA !== orderB) {
            return orderA - orderB;
        }
        return a.id.localeCompare(b.id);
    });
}
export function getChannelPlugin(id) {
    const resolvedId = String(id).trim();
    if (!resolvedId) {
        return undefined;
    }
    return listChannelPlugins().find((plugin) => plugin.id === resolvedId);
}
export function normalizeChannelId(raw) {
    // Channel docking: keep input normalization centralized in src/channels/registry.ts.
    // Plugin registry must be initialized before calling.
    return normalizeAnyChannelId(raw);
}
export { listDiscordDirectoryGroupsFromConfig, listDiscordDirectoryPeersFromConfig, listSlackDirectoryGroupsFromConfig, listSlackDirectoryPeersFromConfig, listTelegramDirectoryGroupsFromConfig, listTelegramDirectoryPeersFromConfig, listWhatsAppDirectoryGroupsFromConfig, listWhatsAppDirectoryPeersFromConfig, } from "./directory-config.js";
export { applyChannelMatchMeta, buildChannelKeyCandidates, normalizeChannelSlug, resolveChannelEntryMatch, resolveChannelEntryMatchWithFallback, resolveChannelMatchConfig, resolveNestedAllowlistDecision, } from "./channel-config.js";
export { formatAllowlistMatchMeta, } from "./allowlist-match.js";
