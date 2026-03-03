import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
const DEFAULT_TABLE_MODES = new Map([
    ["signal", "bullets"],
    ["whatsapp", "bullets"],
]);
const isMarkdownTableMode = (value) => value === "off" || value === "bullets" || value === "code";
function resolveMarkdownModeFromSection(section, accountId) {
    if (!section) {
        return undefined;
    }
    const normalizedAccountId = normalizeAccountId(accountId);
    const accounts = section.accounts;
    if (accounts && typeof accounts === "object") {
        const match = resolveAccountEntry(accounts, normalizedAccountId);
        const matchMode = match?.markdown?.tables;
        if (isMarkdownTableMode(matchMode)) {
            return matchMode;
        }
    }
    const sectionMode = section.markdown?.tables;
    return isMarkdownTableMode(sectionMode) ? sectionMode : undefined;
}
export function resolveMarkdownTableMode(params) {
    const channel = normalizeChannelId(params.channel);
    const defaultMode = channel ? (DEFAULT_TABLE_MODES.get(channel) ?? "code") : "code";
    if (!channel || !params.cfg) {
        return defaultMode;
    }
    const channelsConfig = params.cfg.channels;
    const section = (channelsConfig?.[channel] ??
        params.cfg?.[channel]);
    return resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
}
