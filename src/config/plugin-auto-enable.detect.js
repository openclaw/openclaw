import { configMayNeedPluginAutoEnable, resolveConfiguredPluginAutoEnableCandidates, resolvePluginAutoEnableManifestRegistry, } from "./plugin-auto-enable.shared.js";
export function detectPluginAutoEnableCandidates(params) {
    const env = params.env ?? process.env;
    const config = params.config ?? {};
    if (!configMayNeedPluginAutoEnable(config, env)) {
        return [];
    }
    const registry = resolvePluginAutoEnableManifestRegistry({
        config,
        env,
        manifestRegistry: params.manifestRegistry,
    });
    return resolveConfiguredPluginAutoEnableCandidates({
        config,
        env,
        registry,
    });
}
