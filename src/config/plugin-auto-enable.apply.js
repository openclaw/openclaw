import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import { materializePluginAutoEnableCandidatesInternal, resolvePluginAutoEnableManifestRegistry, } from "./plugin-auto-enable.shared.js";
export function materializePluginAutoEnableCandidates(params) {
    const env = params.env ?? process.env;
    const config = params.config ?? {};
    const manifestRegistry = resolvePluginAutoEnableManifestRegistry({
        config,
        env,
        manifestRegistry: params.manifestRegistry,
    });
    return materializePluginAutoEnableCandidatesInternal({
        config,
        candidates: params.candidates,
        env,
        manifestRegistry,
    });
}
export function applyPluginAutoEnable(params) {
    const candidates = detectPluginAutoEnableCandidates(params);
    return materializePluginAutoEnableCandidates({
        config: params.config,
        candidates,
        env: params.env,
        manifestRegistry: params.manifestRegistry,
    });
}
