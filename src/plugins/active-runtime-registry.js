import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const RUNTIME_MODULE_CANDIDATES = ["./runtime.js", "./runtime.ts"];
let pluginRuntimeModule;
function loadPluginRuntime() {
    if (pluginRuntimeModule) {
        return pluginRuntimeModule;
    }
    for (const candidate of RUNTIME_MODULE_CANDIDATES) {
        try {
            pluginRuntimeModule = require(candidate);
            return pluginRuntimeModule;
        }
        catch {
            // Try built/runtime source candidates in order.
        }
    }
    return null;
}
export function getActiveRuntimePluginRegistry() {
    return loadPluginRuntime()?.getActivePluginRegistry() ?? null;
}
