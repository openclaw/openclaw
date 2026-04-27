import { getActivePluginChannelRegistryFromState } from "../plugins/runtime-channel-state.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeChatChannelId } from "./ids.js";
function listRegisteredChannelPluginEntries() {
    const channelRegistry = getActivePluginChannelRegistryFromState();
    if (channelRegistry?.channels && channelRegistry.channels.length > 0) {
        return channelRegistry.channels;
    }
    return [];
}
export function normalizeChannelId(raw) {
    return normalizeChatChannelId(raw);
}
export function normalizeAnyChannelId(raw) {
    const key = normalizeOptionalLowercaseString(raw);
    if (!key) {
        return null;
    }
    return (listRegisteredChannelPluginEntries().find((entry) => {
        const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
        if (id && id === key) {
            return true;
        }
        return (entry.plugin.meta?.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === key);
    })?.plugin.id ?? null);
}
