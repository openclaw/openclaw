import { listPluginDoctorLegacyConfigRules } from "../../plugins/doctor-contract-registry.js";
import { getBootstrapChannelPlugin } from "./bootstrap-registry.js";
import { loadBundledChannelDoctorContractApi } from "./doctor-contract-api.js";
function collectConfiguredChannelIds(raw) {
    if (!raw || typeof raw !== "object") {
        return [];
    }
    const channels = raw.channels;
    if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
        return [];
    }
    return Object.keys(channels)
        .filter((channelId) => channelId !== "defaults")
        .map((channelId) => channelId);
}
function shouldIncludeLegacyRuleForTouchedPaths(rulePath, touchedPaths) {
    if (!touchedPaths || touchedPaths.length === 0) {
        return true;
    }
    return touchedPaths.some((touchedPath) => {
        const sharedLength = Math.min(rulePath.length, touchedPath.length);
        for (let index = 0; index < sharedLength; index += 1) {
            if (rulePath[index] !== touchedPath[index]) {
                return false;
            }
        }
        return true;
    });
}
function collectRelevantChannelIdsForTouchedPaths(params) {
    const channelIds = collectConfiguredChannelIds(params.raw);
    const filteredChannelIds = params.excludedChannelIds?.size
        ? channelIds.filter((channelId) => !params.excludedChannelIds?.has(channelId))
        : channelIds;
    if (!params.touchedPaths || params.touchedPaths.length === 0) {
        return filteredChannelIds;
    }
    const touchedChannelIds = new Set();
    for (const touchedPath of params.touchedPaths) {
        const [first, second] = touchedPath;
        if (first !== "channels") {
            continue;
        }
        if (!second) {
            return filteredChannelIds;
        }
        if (second === "defaults") {
            continue;
        }
        touchedChannelIds.add(second);
    }
    if (touchedChannelIds.size === 0) {
        return [];
    }
    return filteredChannelIds.filter((channelId) => touchedChannelIds.has(channelId));
}
export function collectChannelLegacyConfigRules(raw, touchedPaths, excludedChannelIds) {
    const channelIds = collectRelevantChannelIdsForTouchedPaths({
        raw,
        touchedPaths,
        excludedChannelIds,
    });
    const rules = [];
    const unresolvedChannelIds = [];
    for (const channelId of channelIds) {
        const contractApi = loadBundledChannelDoctorContractApi(channelId);
        const contractRules = contractApi?.legacyConfigRules;
        if (Array.isArray(contractRules)) {
            rules.push(...contractRules);
            continue;
        }
        const plugin = getBootstrapChannelPlugin(channelId);
        if (plugin?.doctor?.legacyConfigRules?.length) {
            rules.push(...plugin.doctor.legacyConfigRules);
            continue;
        }
        if (plugin) {
            continue;
        }
        unresolvedChannelIds.push(channelId);
    }
    if (unresolvedChannelIds.length > 0) {
        rules.push(...listPluginDoctorLegacyConfigRules({ pluginIds: unresolvedChannelIds }));
    }
    const seen = new Set();
    return rules.filter((rule) => {
        if (!shouldIncludeLegacyRuleForTouchedPaths(rule.path, touchedPaths)) {
            return false;
        }
        const key = `${rule.path.join(".")}::${rule.message}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
