import { normalizeChannelId } from "../channels/plugins/index.js";
import { listChannelPlugins } from "../channels/plugins/registry.js";
import { getActivePluginChannelRegistryVersion } from "../plugins/runtime.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
function buildDefaultTableModes() {
    return new Map(listChannelPlugins()
        .flatMap((plugin) => {
        const defaultMarkdownTableMode = plugin.messaging?.defaultMarkdownTableMode;
        return defaultMarkdownTableMode ? [[plugin.id, defaultMarkdownTableMode]] : [];
    })
        .toSorted(([left], [right]) => left.localeCompare(right)));
}
let cachedDefaultTableModes = null;
let cachedDefaultTableModesRegistryVersion = null;
function getDefaultTableModes() {
    const registryVersion = getActivePluginChannelRegistryVersion();
    if (!cachedDefaultTableModes || cachedDefaultTableModesRegistryVersion !== registryVersion) {
        cachedDefaultTableModes = buildDefaultTableModes();
        cachedDefaultTableModesRegistryVersion = registryVersion;
    }
    return cachedDefaultTableModes;
}
const EMPTY_DEFAULT_TABLE_MODES = new Map();
function bindDefaultTableModesMethod(value) {
    if (typeof value !== "function") {
        return value;
    }
    return value.bind(getDefaultTableModes());
}
export const DEFAULT_TABLE_MODES = new Proxy(EMPTY_DEFAULT_TABLE_MODES, {
    get(_target, prop, _receiver) {
        return bindDefaultTableModesMethod(Reflect.get(getDefaultTableModes(), prop));
    },
});
const isMarkdownTableMode = (value) => value === "off" || value === "bullets" || value === "code" || value === "block";
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
    const defaultMode = channel ? (getDefaultTableModes().get(channel) ?? "code") : "code";
    if (!channel || !params.cfg) {
        return defaultMode;
    }
    const channelsConfig = params.cfg.channels;
    const section = (channelsConfig?.[channel] ??
        params.cfg?.[channel]);
    const resolved = resolveMarkdownModeFromSection(section, params.accountId) ?? defaultMode;
    // "block" stays schema-valid for the shared markdown seam, but this PR
    // keeps runtime delivery on safe text rendering until Slack send support lands.
    return resolved === "block" ? "code" : resolved;
}
