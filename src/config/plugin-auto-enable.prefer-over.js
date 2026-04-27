import fs from "node:fs";
import path from "node:path";
import { getChatChannelMeta, normalizeChatChannelId } from "../channels/registry.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { isRecord, resolveConfigDir, resolveUserPath } from "../utils.js";
const ENV_CATALOG_PATHS = ["OPENCLAW_PLUGIN_CATALOG_PATHS", "OPENCLAW_MPM_CATALOG_PATHS"];
function splitEnvPaths(value) {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (!trimmed) {
        return [];
    }
    return normalizeStringEntries(trimmed.split(/[;,]/g).flatMap((chunk) => chunk.split(path.delimiter)));
}
function resolveExternalCatalogPaths(env) {
    for (const key of ENV_CATALOG_PATHS) {
        const raw = normalizeOptionalString(env[key]);
        if (raw) {
            return splitEnvPaths(raw);
        }
    }
    const configDir = resolveConfigDir(env);
    return [
        path.join(configDir, "mpm", "plugins.json"),
        path.join(configDir, "mpm", "catalog.json"),
        path.join(configDir, "plugins", "catalog.json"),
    ];
}
function parseExternalCatalogChannelEntries(raw) {
    const list = (() => {
        if (Array.isArray(raw)) {
            return raw;
        }
        if (!isRecord(raw)) {
            return [];
        }
        const entries = raw.entries ?? raw.packages ?? raw.plugins;
        return Array.isArray(entries) ? entries : [];
    })();
    const channels = [];
    for (const entry of list) {
        if (!isRecord(entry) || !isRecord(entry.openclaw) || !isRecord(entry.openclaw.channel)) {
            continue;
        }
        const channel = entry.openclaw.channel;
        const id = normalizeOptionalString(channel.id) ?? "";
        if (!id) {
            continue;
        }
        const preferOver = Array.isArray(channel.preferOver)
            ? channel.preferOver.filter((value) => typeof value === "string")
            : [];
        channels.push({ id, preferOver });
    }
    return channels;
}
function resolveExternalCatalogPreferOver(channelId, env) {
    for (const rawPath of resolveExternalCatalogPaths(env)) {
        const resolved = resolveUserPath(rawPath, env);
        if (!fs.existsSync(resolved)) {
            continue;
        }
        try {
            const payload = JSON.parse(fs.readFileSync(resolved, "utf-8"));
            const channel = parseExternalCatalogChannelEntries(payload).find((entry) => entry.id === channelId);
            if (channel) {
                return channel.preferOver;
            }
        }
        catch {
            // Ignore invalid catalog files.
        }
    }
    return [];
}
function resolveBuiltInChannelPreferOver(channelId) {
    const builtInChannelId = normalizeChatChannelId(channelId);
    if (!builtInChannelId) {
        return [];
    }
    return getChatChannelMeta(builtInChannelId)?.preferOver ?? [];
}
function resolvePreferredOverIds(candidate, env, registry) {
    const channelId = candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId;
    const installedPlugin = registry.plugins.find((record) => record.id === candidate.pluginId);
    const manifestChannelPreferOver = installedPlugin?.channelConfigs?.[channelId]?.preferOver;
    if (manifestChannelPreferOver?.length) {
        return [...manifestChannelPreferOver];
    }
    const installedChannelMeta = installedPlugin?.channelCatalogMeta;
    if (installedChannelMeta?.preferOver?.length) {
        return [...installedChannelMeta.preferOver];
    }
    const builtInChannelPreferOver = resolveBuiltInChannelPreferOver(channelId);
    if (builtInChannelPreferOver.length) {
        return [...builtInChannelPreferOver];
    }
    return resolveExternalCatalogPreferOver(channelId, env);
}
function getPluginAutoEnableCandidateCacheKey(candidate) {
    return `${candidate.pluginId}:${candidate.kind === "channel-configured" ? candidate.channelId : candidate.pluginId}`;
}
export function shouldSkipPreferredPluginAutoEnable(params) {
    const getPreferredOverIds = (candidate) => {
        const cacheKey = getPluginAutoEnableCandidateCacheKey(candidate);
        const cached = params.preferOverCache.get(cacheKey);
        if (cached) {
            return cached;
        }
        const resolved = resolvePreferredOverIds(candidate, params.env, params.registry);
        params.preferOverCache.set(cacheKey, resolved);
        return resolved;
    };
    for (const other of params.configured) {
        if (other.pluginId === params.entry.pluginId) {
            continue;
        }
        if (params.isPluginDenied(params.config, other.pluginId) ||
            params.isPluginExplicitlyDisabled(params.config, other.pluginId)) {
            continue;
        }
        if (getPreferredOverIds(other).includes(params.entry.pluginId)) {
            return true;
        }
    }
    return false;
}
