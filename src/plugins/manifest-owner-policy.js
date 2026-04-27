import { resolveEffectivePluginActivationState } from "./config-state.js";
export function isBundledManifestOwner(plugin) {
    return plugin.origin === "bundled";
}
export function hasExplicitManifestOwnerTrust(params) {
    return (params.normalizedConfig.allow.includes(params.plugin.id) ||
        params.normalizedConfig.entries[params.plugin.id]?.enabled === true);
}
export function passesManifestOwnerBasePolicy(params) {
    if (!params.normalizedConfig.enabled) {
        return false;
    }
    if (params.normalizedConfig.deny.includes(params.plugin.id)) {
        return false;
    }
    if (params.normalizedConfig.entries[params.plugin.id]?.enabled === false &&
        params.allowExplicitlyDisabled !== true) {
        return false;
    }
    if (params.allowRestrictiveAllowlistBypass !== true &&
        params.normalizedConfig.allow.length > 0 &&
        !params.normalizedConfig.allow.includes(params.plugin.id)) {
        return false;
    }
    return true;
}
export function isActivatedManifestOwner(params) {
    return resolveEffectivePluginActivationState({
        id: params.plugin.id,
        origin: params.plugin.origin,
        config: params.normalizedConfig,
        rootConfig: params.rootConfig,
        enabledByDefault: params.plugin.enabledByDefault,
    }).activated;
}
