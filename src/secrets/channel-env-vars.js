import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
export { isSafeChannelEnvVarTriggerName } from "./channel-env-var-names.js";
function appendUniqueEnvVarCandidates(target, channelId, keys) {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId || keys.length === 0) {
        return;
    }
    const bucket = (target[normalizedChannelId] ??= []);
    const seen = new Set(bucket);
    for (const key of keys) {
        const normalizedKey = key.trim();
        if (!normalizedKey || seen.has(normalizedKey)) {
            continue;
        }
        seen.add(normalizedKey);
        bucket.push(normalizedKey);
    }
}
export function resolveChannelEnvVars(params) {
    const registry = loadPluginManifestRegistry({
        config: params?.config,
        workspaceDir: params?.workspaceDir,
        env: params?.env,
    });
    const candidates = {};
    for (const plugin of registry.plugins) {
        if (!plugin.channelEnvVars) {
            continue;
        }
        for (const [channelId, keys] of Object.entries(plugin.channelEnvVars).toSorted(([left], [right]) => left.localeCompare(right))) {
            appendUniqueEnvVarCandidates(candidates, channelId, keys);
        }
    }
    return candidates;
}
export function getChannelEnvVars(channelId, params) {
    const channelEnvVars = resolveChannelEnvVars(params);
    const envVars = Object.hasOwn(channelEnvVars, channelId) ? channelEnvVars[channelId] : undefined;
    return Array.isArray(envVars) ? [...envVars] : [];
}
export function listKnownChannelEnvVarNames(params) {
    return [...new Set(Object.values(resolveChannelEnvVars(params)).flatMap((keys) => keys))];
}
