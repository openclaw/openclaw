import { createRequire } from "node:module";
import { normalizeProviderId } from "../agents/provider-id.js";
import { loadPluginRegistrySnapshot } from "./plugin-registry.js";
const require = createRequire(import.meta.url);
const SETUP_REGISTRY_RUNTIME_CANDIDATES = ["./setup-registry.js", "./setup-registry.ts"];
let setupRegistryRuntimeModule;
let bundledSetupCliBackendsCache;
export const __testing = {
    resetRuntimeState() {
        setupRegistryRuntimeModule = undefined;
        bundledSetupCliBackendsCache = undefined;
    },
    setRuntimeModuleForTest(module) {
        setupRegistryRuntimeModule = module;
    },
};
function resolveBundledSetupCliBackends() {
    if (bundledSetupCliBackendsCache) {
        return bundledSetupCliBackendsCache;
    }
    bundledSetupCliBackendsCache = loadPluginRegistrySnapshot({ cache: true }).plugins.flatMap((plugin) => {
        if (plugin.origin !== "bundled" || !plugin.enabled) {
            return [];
        }
        return plugin.contributions.cliBackends.map((backendId) => ({
            pluginId: plugin.pluginId,
            backend: { id: backendId },
        }));
    });
    return bundledSetupCliBackendsCache;
}
function loadSetupRegistryRuntime() {
    if (setupRegistryRuntimeModule !== undefined) {
        return setupRegistryRuntimeModule;
    }
    for (const candidate of SETUP_REGISTRY_RUNTIME_CANDIDATES) {
        try {
            setupRegistryRuntimeModule = require(candidate);
            return setupRegistryRuntimeModule;
        }
        catch {
            // Try source/runtime candidates in order.
        }
    }
    return null;
}
export function resolvePluginSetupCliBackendRuntime(params) {
    const normalized = normalizeProviderId(params.backend);
    const runtime = loadSetupRegistryRuntime();
    if (runtime !== null) {
        return runtime.resolvePluginSetupCliBackend(params);
    }
    return resolveBundledSetupCliBackends().find((entry) => normalizeProviderId(entry.backend.id) === normalized);
}
