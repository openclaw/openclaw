import { normalizeChatChannelId } from "../channels/registry.js";
import { defaultSlotIdForKey } from "./slots.js";
export const BUNDLED_ENABLED_BY_DEFAULT = new Set([
    "device-pair",
    "phone-control",
    "talk-voice",
]);
const normalizeList = (value) => {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
};
const normalizeSlotValue = (value) => {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    if (trimmed.toLowerCase() === "none") {
        return null;
    }
    return trimmed;
};
const normalizePluginEntries = (entries) => {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return {};
    }
    const normalized = {};
    for (const [key, value] of Object.entries(entries)) {
        if (!key.trim()) {
            continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            normalized[key] = {};
            continue;
        }
        const entry = value;
        normalized[key] = {
            enabled: typeof entry.enabled === "boolean" ? entry.enabled : undefined,
            config: "config" in entry ? entry.config : undefined,
        };
    }
    return normalized;
};
export const normalizePluginsConfig = (config) => {
    const memorySlot = normalizeSlotValue(config?.slots?.memory);
    return {
        enabled: config?.enabled !== false,
        allow: normalizeList(config?.allow),
        deny: normalizeList(config?.deny),
        loadPaths: normalizeList(config?.load?.paths),
        slots: {
            memory: memorySlot === undefined ? defaultSlotIdForKey("memory") : memorySlot,
        },
        entries: normalizePluginEntries(config?.entries),
    };
};
const hasExplicitMemorySlot = (plugins) => Boolean(plugins?.slots && Object.prototype.hasOwnProperty.call(plugins.slots, "memory"));
const hasExplicitMemoryEntry = (plugins) => Boolean(plugins?.entries && Object.prototype.hasOwnProperty.call(plugins.entries, "memory-core"));
const hasExplicitPluginConfig = (plugins) => {
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
};
export function applyTestPluginDefaults(cfg, env = process.env) {
    if (!env.VITEST) {
        return cfg;
    }
    const plugins = cfg.plugins;
    const explicitConfig = hasExplicitPluginConfig(plugins);
    if (explicitConfig) {
        if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
            return cfg;
        }
        return {
            ...cfg,
            plugins: {
                ...plugins,
                slots: {
                    ...plugins?.slots,
                    memory: "none",
                },
            },
        };
    }
    return {
        ...cfg,
        plugins: {
            ...plugins,
            enabled: false,
            slots: {
                ...plugins?.slots,
                memory: "none",
            },
        },
    };
}
export function isTestDefaultMemorySlotDisabled(cfg, env = process.env) {
    if (!env.VITEST) {
        return false;
    }
    const plugins = cfg.plugins;
    if (hasExplicitMemorySlot(plugins) || hasExplicitMemoryEntry(plugins)) {
        return false;
    }
    return true;
}
export function resolveEnableState(id, origin, config) {
    if (!config.enabled) {
        return { enabled: false, reason: "plugins disabled" };
    }
    if (config.deny.includes(id)) {
        return { enabled: false, reason: "blocked by denylist" };
    }
    if (config.allow.length > 0 && !config.allow.includes(id)) {
        return { enabled: false, reason: "not in allowlist" };
    }
    if (config.slots.memory === id) {
        return { enabled: true };
    }
    const entry = config.entries[id];
    if (entry?.enabled === true) {
        return { enabled: true };
    }
    if (entry?.enabled === false) {
        return { enabled: false, reason: "disabled in config" };
    }
    if (origin === "bundled" && BUNDLED_ENABLED_BY_DEFAULT.has(id)) {
        return { enabled: true };
    }
    if (origin === "bundled") {
        return { enabled: false, reason: "bundled (disabled by default)" };
    }
    return { enabled: true };
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
export function resolveEffectiveEnableState(params) {
    const base = resolveEnableState(params.id, params.origin, params.config);
    if (!base.enabled &&
        base.reason === "bundled (disabled by default)" &&
        isBundledChannelEnabledByChannelConfig(params.rootConfig, params.id)) {
        return { enabled: true };
    }
    return base;
}
export function resolveMemorySlotDecision(params) {
    if (params.kind !== "memory") {
        return { enabled: true };
    }
    if (params.slot === null) {
        return { enabled: false, reason: "memory slot disabled" };
    }
    if (typeof params.slot === "string") {
        if (params.slot === params.id) {
            return { enabled: true, selected: true };
        }
        return {
            enabled: false,
            reason: `memory slot set to "${params.slot}"`,
        };
    }
    if (params.selectedId && params.selectedId !== params.id) {
        return {
            enabled: false,
            reason: `memory slot already filled by "${params.selectedId}"`,
        };
    }
    return { enabled: true, selected: true };
}
