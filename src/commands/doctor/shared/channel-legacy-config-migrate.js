import { getBootstrapChannelPlugin } from "../../../channels/plugins/bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "../../../channels/plugins/doctor-contract-api.js";
import { applyPluginDoctorCompatibilityMigrations } from "../../../plugins/doctor-contract-registry.js";
import { isRecord } from "./legacy-config-record-shared.js";
function collectRelevantDoctorChannelIds(raw) {
    const channels = isRecord(raw) && isRecord(raw.channels) ? raw.channels : null;
    if (!channels) {
        return [];
    }
    return Object.keys(channels)
        .filter((channelId) => channelId !== "defaults")
        .toSorted();
}
function resolveBundledChannelCompatibilityNormalizer(channelId) {
    const contractNormalizer = loadBundledChannelDoctorContractApi(channelId)?.normalizeCompatibilityConfig;
    if (typeof contractNormalizer === "function") {
        return contractNormalizer;
    }
    return getBootstrapChannelPlugin(channelId)?.doctor?.normalizeCompatibilityConfig;
}
export function applyChannelDoctorCompatibilityMigrations(cfg) {
    let nextCfg = cfg;
    const changes = [];
    const unresolvedChannelIds = [];
    for (const channelId of collectRelevantDoctorChannelIds(cfg)) {
        const normalizeCompatibilityConfig = resolveBundledChannelCompatibilityNormalizer(channelId);
        if (!normalizeCompatibilityConfig) {
            unresolvedChannelIds.push(channelId);
            continue;
        }
        const mutation = normalizeCompatibilityConfig({ cfg: nextCfg });
        if (!mutation || mutation.changes.length === 0) {
            continue;
        }
        nextCfg = mutation.config;
        changes.push(...mutation.changes);
    }
    if (unresolvedChannelIds.length > 0) {
        const compat = applyPluginDoctorCompatibilityMigrations(nextCfg, {
            pluginIds: unresolvedChannelIds,
        });
        nextCfg = compat.config;
        changes.push(...compat.changes);
    }
    return {
        next: nextCfg,
        changes,
    };
}
