import { loadBundledPluginPublicArtifactModuleSync } from "./public-surface-loader.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isProviderPlugin(value) {
    return (isRecord(value) &&
        typeof value.id === "string" &&
        typeof value.label === "string" &&
        Array.isArray(value.auth));
}
function tryLoadProviderContractApi(pluginId) {
    try {
        return loadBundledPluginPublicArtifactModuleSync({
            dirName: pluginId,
            artifactBasename: "provider-contract-api.js",
        });
    }
    catch (error) {
        if (error instanceof Error &&
            error.message.startsWith("Unable to resolve bundled plugin public surface ")) {
            return null;
        }
        throw error;
    }
}
function collectProviderContractEntries(params) {
    const providers = [];
    for (const [name, exported] of Object.entries(params.mod).toSorted(([left], [right]) => left.localeCompare(right))) {
        if (typeof exported !== "function" ||
            exported.length !== 0 ||
            !name.startsWith("create") ||
            !name.endsWith("Provider")) {
            continue;
        }
        const candidate = exported();
        if (isProviderPlugin(candidate)) {
            providers.push({ pluginId: params.pluginId, provider: candidate });
        }
    }
    return providers;
}
export function resolveBundledExplicitProviderContractsFromPublicArtifacts(params) {
    const providers = [];
    for (const pluginId of [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right))) {
        const mod = tryLoadProviderContractApi(pluginId);
        if (!mod) {
            return null;
        }
        const entries = collectProviderContractEntries({ pluginId, mod });
        if (entries.length === 0) {
            return null;
        }
        providers.push(...entries);
    }
    return providers;
}
