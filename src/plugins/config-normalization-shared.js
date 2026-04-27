import { normalizeChatChannelId } from "../channels/ids.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
import { defaultSlotIdForKey } from "./slots.js";
export const identityNormalizePluginId = (id) => id.trim();
function normalizeList(value, normalizePluginId) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => (typeof entry === "string" ? normalizePluginId(entry) : ""))
        .filter(Boolean);
}
function normalizeSlotValue(value) {
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return undefined;
    }
    if (normalizeOptionalLowercaseString(trimmed) === "none") {
        return null;
    }
    return trimmed;
}
function normalizePluginEntries(entries, normalizePluginId) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(entries)) {
        const normalizedKey = normalizePluginId(key);
        if (!normalizedKey) {
            continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            normalized[normalizedKey] = {};
            continue;
        }
        const entry = value;
        const hooksRaw = entry.hooks;
        const hooks = hooksRaw && typeof hooksRaw === "object" && !Array.isArray(hooksRaw)
            ? {
                allowPromptInjection: hooksRaw
                    .allowPromptInjection,
                allowConversationAccess: hooksRaw
                    .allowConversationAccess,
            }
            : undefined;
        const normalizedHooks = hooks &&
            (typeof hooks.allowPromptInjection === "boolean" ||
                typeof hooks.allowConversationAccess === "boolean")
            ? {
                ...(typeof hooks.allowPromptInjection === "boolean"
                    ? { allowPromptInjection: hooks.allowPromptInjection }
                    : {}),
                ...(typeof hooks.allowConversationAccess === "boolean"
                    ? { allowConversationAccess: hooks.allowConversationAccess }
                    : {}),
            }
            : undefined;
        const subagentRaw = entry.subagent;
        const subagent = subagentRaw && typeof subagentRaw === "object" && !Array.isArray(subagentRaw)
            ? {
                allowModelOverride: subagentRaw
                    .allowModelOverride,
                hasAllowedModelsConfig: Array.isArray(subagentRaw.allowedModels),
                allowedModels: Array.isArray(subagentRaw.allowedModels)
                    ? subagentRaw.allowedModels
                        .map((model) => normalizeOptionalString(model))
                        .filter((model) => Boolean(model))
                    : undefined,
            }
            : undefined;
        const normalizedSubagent = subagent &&
            (typeof subagent.allowModelOverride === "boolean" ||
                subagent.hasAllowedModelsConfig ||
                (Array.isArray(subagent.allowedModels) && subagent.allowedModels.length > 0))
            ? {
                ...(typeof subagent.allowModelOverride === "boolean"
                    ? { allowModelOverride: subagent.allowModelOverride }
                    : {}),
                ...(subagent.hasAllowedModelsConfig ? { hasAllowedModelsConfig: true } : {}),
                ...(Array.isArray(subagent.allowedModels) && subagent.allowedModels.length > 0
                    ? { allowedModels: subagent.allowedModels }
                    : {}),
            }
            : undefined;
        normalized[normalizedKey] = {
            ...normalized[normalizedKey],
            enabled: typeof entry.enabled === "boolean" ? entry.enabled : normalized[normalizedKey]?.enabled,
            hooks: normalizedHooks ?? normalized[normalizedKey]?.hooks,
            subagent: normalizedSubagent ?? normalized[normalizedKey]?.subagent,
            config: "config" in entry ? entry.config : normalized[normalizedKey]?.config,
        };
    }
    return normalized;
}
export function normalizePluginsConfigWithResolver(config, normalizePluginId = identityNormalizePluginId) {
    const memorySlot = normalizeSlotValue(config?.slots?.memory);
    return {
        enabled: config?.enabled !== false,
        allow: normalizeList(config?.allow, normalizePluginId),
        deny: normalizeList(config?.deny, normalizePluginId),
        loadPaths: normalizeList(config?.load?.paths, identityNormalizePluginId),
        slots: {
            memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
            contextEngine: normalizeSlotValue(config?.slots?.contextEngine),
        },
        entries: normalizePluginEntries(config?.entries, normalizePluginId),
    };
}
export function hasExplicitPluginConfig(plugins) {
    if (!plugins) {
        return false;
    }
    if (typeof plugins.enabled === "boolean") {
        return true;
    }
    if (Array.isArray(plugins.allow) && plugins.allow.length > 0) {
        return true;
    }
    if (Array.isArray(plugins.deny) && plugins.deny.length > 0) {
        return true;
    }
    if (plugins.load?.paths && Array.isArray(plugins.load.paths) && plugins.load.paths.length > 0) {
        return true;
    }
    if (plugins.slots && Object.keys(plugins.slots).length > 0) {
        return true;
    }
    if (plugins.entries && Object.keys(plugins.entries).length > 0) {
        return true;
    }
    return false;
}
export function isBundledChannelEnabledByChannelConfig(cfg, pluginId) {
    if (!cfg) {
        return false;
    }
    const channelId = normalizeChatChannelId(pluginId);
    if (!channelId) {
        return false;
    }
    const channels = cfg.channels;
    const entry = channels?.[channelId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return false;
    }
    return entry.enabled === true;
}
