import path from "node:path";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolveBundledWebFetchResolutionConfig } from "./web-fetch-providers.shared.js";
import { loadBundledWebFetchProviderEntriesFromDir, loadBundledWebSearchProviderEntriesFromDir, resolveBundledExplicitWebFetchProvidersFromPublicArtifacts, resolveBundledExplicitWebSearchProvidersFromPublicArtifacts, } from "./web-provider-public-artifacts.explicit.js";
import { resolveManifestDeclaredWebProviderCandidatePluginIds } from "./web-provider-resolution-shared.js";
import { resolveBundledWebSearchResolutionConfig } from "./web-search-providers.shared.js";
function resolveBundledCandidatePluginIds(params) {
    if (params.onlyPluginIds && params.onlyPluginIds.length > 0) {
        return [...new Set(params.onlyPluginIds)].toSorted((left, right) => left.localeCompare(right));
    }
    const resolvedConfig = params.contract === "webSearchProviders"
        ? resolveBundledWebSearchResolutionConfig(params).config
        : resolveBundledWebFetchResolutionConfig(params).config;
    return (resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: params.contract,
        configKey: params.configKey,
        config: resolvedConfig,
        workspaceDir: params.workspaceDir,
        env: params.env,
        onlyPluginIds: params.onlyPluginIds,
        origin: "bundled",
    }) ?? []);
}
function resolveBundledManifestRecordsByPluginId(params) {
    const allowedPluginIds = new Set(params.onlyPluginIds);
    return new Map(loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    })
        .plugins.filter((record) => record.origin === "bundled" && allowedPluginIds.has(record.id))
        .map((record) => [record.id, record]));
}
export function resolveBundledWebSearchProvidersFromPublicArtifacts(params) {
    const pluginIds = resolveBundledCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
        onlyPluginIds: params.onlyPluginIds,
    });
    if (pluginIds.length === 0) {
        return [];
    }
    const directProviders = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: pluginIds,
    });
    if (directProviders) {
        return directProviders;
    }
    const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        onlyPluginIds: pluginIds,
    });
    const providers = [];
    for (const pluginId of pluginIds) {
        const record = recordsByPluginId.get(pluginId);
        if (!record) {
            return null;
        }
        const loadedProviders = loadBundledWebSearchProviderEntriesFromDir({
            dirName: path.basename(record.rootDir),
            pluginId,
        });
        if (!loadedProviders) {
            return null;
        }
        providers.push(...loadedProviders);
    }
    return providers;
}
export function resolveBundledWebFetchProvidersFromPublicArtifacts(params) {
    const pluginIds = resolveBundledCandidatePluginIds({
        contract: "webFetchProviders",
        configKey: "webFetch",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
        onlyPluginIds: params.onlyPluginIds,
    });
    if (pluginIds.length === 0) {
        return [];
    }
    const directProviders = resolveBundledExplicitWebFetchProvidersFromPublicArtifacts({
        onlyPluginIds: pluginIds,
    });
    if (directProviders) {
        return directProviders;
    }
    const recordsByPluginId = resolveBundledManifestRecordsByPluginId({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        onlyPluginIds: pluginIds,
    });
    const providers = [];
    for (const pluginId of pluginIds) {
        const record = recordsByPluginId.get(pluginId);
        if (!record) {
            return null;
        }
        const loadedProviders = loadBundledWebFetchProviderEntriesFromDir({
            dirName: path.basename(record.rootDir),
            pluginId,
        });
        if (!loadedProviders) {
            return null;
        }
        providers.push(...loadedProviders);
    }
    return providers;
}
