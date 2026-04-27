import fs from "node:fs";
import os from "node:os";
import { hasBundledChannelPersistedAuthState, listBundledChannelIdsWithPersistedAuthState, } from "../channels/plugins/persisted-auth-state.js";
import { resolveStateDir } from "../config/paths.js";
import { hasNonEmptyString } from "../infra/outbound/channel-target.js";
import { isRecord } from "../utils.js";
import { listBundledChannelPluginIds } from "./plugins/bundled-ids.js";
const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
export function hasMeaningfulChannelConfig(value) {
    if (!isRecord(value)) {
        return false;
    }
    return Object.keys(value).some((key) => key !== "enabled");
}
function listChannelEnvPrefixes(channelIds) {
    return channelIds.map((channelId) => [
        `${channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`,
        channelId,
    ]);
}
function hasPersistedChannelState(env) {
    return fs.existsSync(resolveStateDir(env, os.homedir));
}
let persistedAuthStateChannelIds = null;
function listPersistedAuthStateChannelIds(options) {
    const override = options.persistedAuthStateProbe?.listChannelIds();
    if (override) {
        return override;
    }
    if (persistedAuthStateChannelIds) {
        return persistedAuthStateChannelIds;
    }
    persistedAuthStateChannelIds = listBundledChannelIdsWithPersistedAuthState();
    return persistedAuthStateChannelIds;
}
function hasPersistedAuthState(params) {
    const override = params.options.persistedAuthStateProbe;
    if (override) {
        return override.hasState(params);
    }
    return hasBundledChannelPersistedAuthState(params);
}
export function listPotentialConfiguredChannelIds(cfg, env = process.env, options = {}) {
    return [
        ...new Set(listPotentialConfiguredChannelPresenceSignals(cfg, env, options).map((signal) => signal.channelId)),
    ];
}
export function listPotentialConfiguredChannelPresenceSignals(cfg, env = process.env, options = {}) {
    const signals = [];
    const seenSignals = new Set();
    const addSignal = (channelId, source) => {
        const key = `${source}:${channelId}`;
        if (seenSignals.has(key)) {
            return;
        }
        seenSignals.add(key);
        signals.push({ channelId, source });
    };
    const configuredChannelIds = new Set();
    const channelIds = listBundledChannelPluginIds();
    const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
    const channels = isRecord(cfg.channels) ? cfg.channels : null;
    if (channels) {
        for (const [key, value] of Object.entries(channels)) {
            if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
                continue;
            }
            if (hasMeaningfulChannelConfig(value)) {
                configuredChannelIds.add(key);
                addSignal(key, "config");
            }
        }
    }
    for (const [key, value] of Object.entries(env)) {
        if (!hasNonEmptyString(value)) {
            continue;
        }
        for (const [prefix, channelId] of channelEnvPrefixes) {
            if (key.startsWith(prefix)) {
                configuredChannelIds.add(channelId);
                addSignal(channelId, "env");
            }
        }
    }
    if (options.includePersistedAuthState !== false && hasPersistedChannelState(env)) {
        for (const channelId of listPersistedAuthStateChannelIds(options)) {
            if (hasPersistedAuthState({ channelId, cfg, env, options })) {
                configuredChannelIds.add(channelId);
                addSignal(channelId, "persisted-auth");
            }
        }
    }
    return signals.filter((signal) => configuredChannelIds.has(signal.channelId));
}
function hasEnvConfiguredChannel(cfg, env, options = {}) {
    const channelIds = listBundledChannelPluginIds();
    const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
    for (const [key, value] of Object.entries(env)) {
        if (!hasNonEmptyString(value)) {
            continue;
        }
        if (channelEnvPrefixes.some(([prefix]) => key.startsWith(prefix))) {
            return true;
        }
    }
    if (options.includePersistedAuthState === false || !hasPersistedChannelState(env)) {
        return false;
    }
    return listPersistedAuthStateChannelIds(options).some((channelId) => hasPersistedAuthState({ channelId, cfg, env, options }));
}
export function hasPotentialConfiguredChannels(cfg, env = process.env, options = {}) {
    const channels = isRecord(cfg?.channels) ? cfg.channels : null;
    if (channels) {
        for (const [key, value] of Object.entries(channels)) {
            if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
                continue;
            }
            if (hasMeaningfulChannelConfig(value)) {
                return true;
            }
        }
    }
    return hasEnvConfiguredChannel(cfg ?? {}, env, options);
}
