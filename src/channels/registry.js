import { getActivePluginChannelRegistryFromState } from "../plugins/runtime-channel-state.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
import { CHAT_CHANNEL_ALIASES, listChatChannelAliases, normalizeChatChannelId, } from "./ids.js";
export { getChatChannelMeta, listChatChannels } from "./chat-meta.js";
export { CHANNEL_IDS, CHAT_CHANNEL_ORDER } from "./ids.js";
function listRegisteredChannelPluginEntries() {
    const channelRegistry = getActivePluginChannelRegistryFromState();
    if (channelRegistry && channelRegistry.channels && channelRegistry.channels.length > 0) {
        return channelRegistry.channels;
    }
    return [];
}
function findRegisteredChannelPluginEntry(normalizedKey) {
    return listRegisteredChannelPluginEntries().find((entry) => {
        const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
        if (id && id === normalizedKey) {
            return true;
        }
        return (entry.plugin.meta?.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === normalizedKey);
    });
}
function findRegisteredChannelPluginEntryById(id) {
    const normalizedId = normalizeOptionalLowercaseString(id);
    if (!normalizedId) {
        return undefined;
    }
    return listRegisteredChannelPluginEntries().find((entry) => normalizeOptionalLowercaseString(entry.plugin.id) === normalizedId);
}
export { CHAT_CHANNEL_ALIASES, listChatChannelAliases, normalizeChatChannelId };
// Channel docking: prefer this helper in shared code. Importing from
// `src/channels/plugins/*` can eagerly load channel implementations.
export function normalizeChannelId(raw) {
    return normalizeChatChannelId(raw);
}
// Normalizes registered channel plugins (bundled or external).
//
// Keep this light: we do not import channel plugins here (those are "heavy" and can pull in
// monitors, web login, etc). The plugin registry must be initialized first.
export function normalizeAnyChannelId(raw) {
    const key = normalizeOptionalLowercaseString(raw);
    if (!key) {
        return null;
    }
    return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}
export function listRegisteredChannelPluginIds() {
    return listRegisteredChannelPluginEntries().flatMap((entry) => {
        const id = normalizeOptionalString(entry.plugin.id);
        return id ? [id] : [];
    });
}
export function listRegisteredChannelPluginAliases() {
    return listRegisteredChannelPluginEntries().flatMap((entry) => entry.plugin.meta?.aliases ?? []);
}
export function getRegisteredChannelPluginMeta(id) {
    return findRegisteredChannelPluginEntryById(id)?.plugin.meta ?? null;
}
export function formatChannelPrimerLine(meta) {
    return `${meta.label}: ${meta.blurb}`;
}
export function formatChannelSelectionLine(meta, docsLink) {
    const docsPrefix = meta.selectionDocsPrefix ?? "Docs:";
    const docsLabel = meta.docsLabel ?? meta.id;
    const docs = meta.selectionDocsOmitLabel
        ? docsLink(meta.docsPath)
        : docsLink(meta.docsPath, docsLabel);
    const extras = (meta.selectionExtras ?? []).filter(Boolean).join(" ");
    return `${meta.label} — ${meta.blurb} ${docsPrefix ? `${docsPrefix} ` : ""}${docs}${extras ? ` ${extras}` : ""}`;
}
