import { applyCompactionDefaults, applyContextPruningDefaults, applyAgentDefaults, applyLoggingDefaults, applyMessageDefaults, applyModelDefaults, applySessionDefaults, applyTalkConfigNormalization, } from "./defaults.js";
import { normalizeExecSafeBinProfilesInConfig } from "./normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "./normalize-paths.js";
const MATERIALIZATION_PROFILES = {
    load: {
        includeCompactionDefaults: true,
        includeContextPruningDefaults: true,
        includeLoggingDefaults: true,
        normalizePaths: true,
    },
    missing: {
        includeCompactionDefaults: true,
        includeContextPruningDefaults: true,
        includeLoggingDefaults: false,
        normalizePaths: false,
    },
    snapshot: {
        includeCompactionDefaults: false,
        includeContextPruningDefaults: false,
        includeLoggingDefaults: true,
        normalizePaths: true,
    },
};
export function asResolvedSourceConfig(config) {
    return config;
}
export function asRuntimeConfig(config) {
    return config;
}
export function materializeRuntimeConfig(config, mode) {
    const profile = MATERIALIZATION_PROFILES[mode];
    let next = applyMessageDefaults(config);
    if (profile.includeLoggingDefaults) {
        next = applyLoggingDefaults(next);
    }
    next = applySessionDefaults(next);
    next = applyAgentDefaults(next);
    if (profile.includeContextPruningDefaults) {
        next = applyContextPruningDefaults(next);
    }
    if (profile.includeCompactionDefaults) {
        next = applyCompactionDefaults(next);
    }
    next = applyModelDefaults(next);
    next = applyTalkConfigNormalization(next);
    if (profile.normalizePaths) {
        normalizeConfigPaths(next);
    }
    normalizeExecSafeBinProfilesInConfig(next);
    return asRuntimeConfig(next);
}
