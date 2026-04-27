import { normalizeProviderId } from "../agents/model-selection.js";
import { listPluginContributionIds, loadPluginRegistrySnapshot, } from "./plugin-registry.js";
const DISCOVERY_ORDER = ["simple", "profile", "paired", "late"];
const DANGEROUS_PROVIDER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let providerRuntimePromise;
function loadProviderRuntime() {
    providerRuntimePromise ??= import("./provider-discovery.runtime.js");
    return providerRuntimePromise;
}
function resolveProviderCatalogHook(provider) {
    return provider.catalog ?? provider.discovery;
}
function resolveProviderCatalogOrderHook(provider) {
    return resolveProviderCatalogHook(provider) ?? provider.staticCatalog;
}
function createProviderConfigRecord() {
    return Object.create(null);
}
function isSafeProviderConfigKey(value) {
    return value !== "" && !DANGEROUS_PROVIDER_KEYS.has(value);
}
function sortedValues(values) {
    return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}
export function resolveInstalledPluginProviderContributionIds(params = {}) {
    const registryParams = params.candidates && params.preferPersisted === undefined
        ? { ...params, preferPersisted: false }
        : params;
    const index = params.index ?? loadPluginRegistrySnapshot(registryParams);
    return sortedValues(listPluginContributionIds({
        index,
        contribution: "providers",
        includeDisabled: params.includeDisabled,
        config: params.config,
    }));
}
export async function resolveRuntimePluginDiscoveryProviders(params) {
    return (await loadProviderRuntime())
        .resolvePluginDiscoveryProvidersRuntime(params)
        .filter((provider) => resolveProviderCatalogOrderHook(provider));
}
export async function resolvePluginDiscoveryProviders(params) {
    return resolveRuntimePluginDiscoveryProviders(params);
}
export function groupPluginDiscoveryProvidersByOrder(providers) {
    const grouped = {
        simple: [],
        profile: [],
        paired: [],
        late: [],
    };
    for (const provider of providers) {
        const order = resolveProviderCatalogOrderHook(provider)?.order ?? "late";
        grouped[order].push(provider);
    }
    for (const order of DISCOVERY_ORDER) {
        grouped[order].sort((a, b) => a.label.localeCompare(b.label));
    }
    return grouped;
}
export function normalizePluginDiscoveryResult(params) {
    const result = params.result;
    if (!result) {
        return {};
    }
    if ("provider" in result) {
        const normalized = createProviderConfigRecord();
        for (const providerId of [
            params.provider.id,
            ...(params.provider.aliases ?? []),
            ...(params.provider.hookAliases ?? []),
        ]) {
            const normalizedKey = normalizeProviderId(providerId);
            if (!isSafeProviderConfigKey(normalizedKey)) {
                continue;
            }
            normalized[normalizedKey] = result.provider;
        }
        return normalized;
    }
    const normalized = createProviderConfigRecord();
    for (const [key, value] of Object.entries(result.providers)) {
        const normalizedKey = normalizeProviderId(key);
        if (!isSafeProviderConfigKey(normalizedKey) || !value) {
            continue;
        }
        normalized[normalizedKey] = value;
    }
    return normalized;
}
export function runProviderCatalog(params) {
    return resolveProviderCatalogHook(params.provider)?.run({
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        env: params.env,
        resolveProviderApiKey: params.resolveProviderApiKey,
        resolveProviderAuth: params.resolveProviderAuth,
    });
}
export function runProviderStaticCatalog(params) {
    return params.provider.staticCatalog?.run({
        config: {},
        env: {},
        resolveProviderApiKey: () => ({
            apiKey: undefined,
        }),
        resolveProviderAuth: () => ({
            apiKey: undefined,
            mode: "none",
            source: "none",
        }),
    });
}
