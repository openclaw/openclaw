import { getRuntimeConfigSnapshot, getRuntimeConfigSourceSnapshot, } from "../config/runtime-snapshot.js";
export function resolvePluginActivationSourceConfig(params) {
    if (params.activationSourceConfig !== undefined) {
        return params.activationSourceConfig;
    }
    const sourceSnapshot = getRuntimeConfigSourceSnapshot();
    if (sourceSnapshot && params.config === getRuntimeConfigSnapshot()) {
        return sourceSnapshot;
    }
    return params.config ?? {};
}
