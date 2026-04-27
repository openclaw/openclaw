import fs from "node:fs";
import path from "node:path";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
import { normalizeOptionalTrimmedStringList } from "../shared/string-normalization.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolveUserPath } from "../utils.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { loadBundleManifest } from "./bundle-manifest.js";
import { normalizePluginsConfigWithResolver, } from "./config-policy.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginInstallRecordsSync } from "./install-ledger-store.js";
import { pluginManifestRegistryCache, } from "./manifest-registry-state.js";
import { loadPluginManifest, } from "./manifest.js";
import { checkMinHostVersion } from "./min-host-version.js";
import { isPathInside, safeRealpathSync } from "./path-safety.js";
import { resolvePluginCacheInputs } from "./roots.js";
/**
 * Resolve a plugin source path, falling back from .ts to .js when the
 * .ts file doesn't exist on disk (e.g. in dist builds where only .js
 * is emitted but the manifest still references the .ts entry).
 */
function resolvePluginSourcePath(sourcePath) {
    if (fs.existsSync(sourcePath)) {
        return sourcePath;
    }
    if (sourcePath.endsWith(".ts")) {
        const jsPath = sourcePath.slice(0, -3) + ".js";
        if (fs.existsSync(jsPath)) {
            return jsPath;
        }
    }
    return sourcePath;
}
// Canonicalize identical physical plugin roots with the most explicit source.
// This only applies when multiple candidates resolve to the same on-disk plugin.
const PLUGIN_ORIGIN_RANK = {
    config: 0,
    workspace: 1,
    global: 2,
    bundled: 3,
};
const registryCache = pluginManifestRegistryCache;
// Keep a short cache window to collapse bursty reloads during startup flows.
const DEFAULT_MANIFEST_CACHE_MS = 1000;
export { clearPluginManifestRegistryCache } from "./manifest-registry-state.js";
function listContractValues(plugin, contract) {
    return plugin.contracts?.[contract] ?? [];
}
export function resolveManifestContractPluginIds(params) {
    const onlyPluginIdSet = params.onlyPluginIds && params.onlyPluginIds.length > 0 ? new Set(params.onlyPluginIds) : null;
    return loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    })
        .plugins.filter((plugin) => (!params.origin || plugin.origin === params.origin) &&
        (!onlyPluginIdSet || onlyPluginIdSet.has(plugin.id)) &&
        listContractValues(plugin, params.contract).length > 0)
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right));
}
export function resolveManifestContractPluginIdsByCompatibilityRuntimePath(params) {
    const normalizedPath = params.path?.trim();
    if (!normalizedPath) {
        return [];
    }
    return loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    })
        .plugins.filter((plugin) => (!params.origin || plugin.origin === params.origin) &&
        listContractValues(plugin, params.contract).length > 0 &&
        (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(normalizedPath))
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right));
}
export function resolveManifestContractOwnerPluginId(params) {
    const normalizedValue = normalizeOptionalLowercaseString(params.value);
    if (!normalizedValue) {
        return undefined;
    }
    return loadPluginManifestRegistry({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
    }).plugins.find((plugin) => (!params.origin || plugin.origin === params.origin) &&
        listContractValues(plugin, params.contract).some((candidate) => normalizeOptionalLowercaseString(candidate) === normalizedValue))?.id;
}
function resolveManifestCacheMs(env) {
    const raw = env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS?.trim();
    if (raw === "" || raw === "0") {
        return 0;
    }
    if (!raw) {
        return DEFAULT_MANIFEST_CACHE_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_MANIFEST_CACHE_MS;
    }
    return Math.max(0, parsed);
}
function shouldUseManifestCache(env) {
    const disabled = env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE?.trim();
    if (disabled) {
        return false;
    }
    return resolveManifestCacheMs(env) > 0;
}
function buildCacheKey(params) {
    const { roots, loadPaths } = resolvePluginCacheInputs({
        workspaceDir: params.workspaceDir,
        loadPaths: params.plugins.loadPaths,
        env: params.env,
    });
    const workspaceKey = roots.workspace ?? "";
    const configExtensionsRoot = roots.global;
    const bundledRoot = roots.stock ?? "";
    const runtimeServiceVersion = resolveCompatibilityHostVersion(params.env);
    // The manifest registry only depends on where plugins are discovered from (workspace + load paths).
    // It does not depend on allow/deny/entries enable-state, so exclude those for higher cache hit rates.
    return `${workspaceKey}::${configExtensionsRoot}::${bundledRoot}::${runtimeServiceVersion}::${JSON.stringify(loadPaths)}`;
}
function safeStatMtimeMs(filePath) {
    try {
        return fs.statSync(filePath).mtimeMs;
    }
    catch {
        return null;
    }
}
function normalizePreferredPluginIds(raw) {
    return normalizeOptionalTrimmedStringList(raw);
}
function mergePackageChannelMetaIntoChannelConfigs(params) {
    const channelId = params.packageChannel?.id?.trim();
    if (!channelId ||
        isBlockedObjectKey(channelId) ||
        !params.channelConfigs ||
        !Object.prototype.hasOwnProperty.call(params.channelConfigs, channelId)) {
        return params.channelConfigs;
    }
    const existing = params.channelConfigs[channelId];
    if (!existing) {
        return params.channelConfigs;
    }
    const label = existing.label ?? normalizeOptionalString(params.packageChannel?.label) ?? "";
    const description = existing.description ?? normalizeOptionalString(params.packageChannel?.blurb) ?? "";
    const preferOver = existing.preferOver ?? normalizePreferredPluginIds(params.packageChannel?.preferOver);
    const merged = Object.create(null);
    for (const [key, value] of Object.entries(params.channelConfigs)) {
        if (!isBlockedObjectKey(key)) {
            merged[key] = value;
        }
    }
    merged[channelId] = {
        ...existing,
        ...(label ? { label } : {}),
        ...(description ? { description } : {}),
        ...(preferOver?.length ? { preferOver } : {}),
    };
    return merged;
}
function buildRecord(params) {
    const channelConfigs = mergePackageChannelMetaIntoChannelConfigs({
        channelConfigs: params.manifest.channelConfigs,
        packageChannel: params.candidate.packageManifest?.channel,
    });
    return {
        id: params.manifest.id,
        name: normalizeOptionalString(params.manifest.name) ?? params.candidate.packageName,
        description: normalizeOptionalString(params.manifest.description) ?? params.candidate.packageDescription,
        version: normalizeOptionalString(params.manifest.version) ?? params.candidate.packageVersion,
        enabledByDefault: params.manifest.enabledByDefault === true ? true : undefined,
        autoEnableWhenConfiguredProviders: params.manifest.autoEnableWhenConfiguredProviders,
        legacyPluginIds: params.manifest.legacyPluginIds,
        format: params.candidate.format ?? "openclaw",
        bundleFormat: params.candidate.bundleFormat,
        kind: params.manifest.kind,
        channels: params.manifest.channels ?? [],
        providers: params.manifest.providers ?? [],
        providerDiscoverySource: params.manifest.providerDiscoveryEntry
            ? resolvePluginSourcePath(path.resolve(params.candidate.rootDir, params.manifest.providerDiscoveryEntry))
            : undefined,
        modelSupport: params.manifest.modelSupport,
        modelCatalog: params.manifest.modelCatalog,
        providerEndpoints: params.manifest.providerEndpoints,
        cliBackends: params.manifest.cliBackends ?? [],
        syntheticAuthRefs: params.manifest.syntheticAuthRefs ?? [],
        nonSecretAuthMarkers: params.manifest.nonSecretAuthMarkers ?? [],
        commandAliases: params.manifest.commandAliases,
        providerAuthEnvVars: params.manifest.providerAuthEnvVars,
        providerAuthAliases: params.manifest.providerAuthAliases,
        channelEnvVars: params.manifest.channelEnvVars,
        providerAuthChoices: params.manifest.providerAuthChoices,
        activation: params.manifest.activation,
        setup: params.manifest.setup,
        qaRunners: params.manifest.qaRunners,
        skills: params.manifest.skills ?? [],
        settingsFiles: [],
        hooks: [],
        origin: params.candidate.origin,
        workspaceDir: params.candidate.workspaceDir,
        rootDir: params.candidate.rootDir,
        source: params.candidate.source,
        setupSource: params.candidate.setupSource,
        startupDeferConfiguredChannelFullLoadUntilAfterListen: params.candidate.packageManifest?.startup?.deferConfiguredChannelFullLoadUntilAfterListen ===
            true,
        manifestPath: params.manifestPath,
        schemaCacheKey: params.schemaCacheKey,
        configSchema: params.configSchema,
        configUiHints: params.manifest.uiHints,
        contracts: params.manifest.contracts,
        mediaUnderstandingProviderMetadata: params.manifest.mediaUnderstandingProviderMetadata,
        configContracts: params.manifest.configContracts,
        channelConfigs,
        ...(params.candidate.packageManifest?.channel?.id
            ? {
                channelCatalogMeta: {
                    id: params.candidate.packageManifest.channel.id,
                    ...(typeof params.candidate.packageManifest.channel.label === "string"
                        ? { label: params.candidate.packageManifest.channel.label }
                        : {}),
                    ...(typeof params.candidate.packageManifest.channel.blurb === "string"
                        ? { blurb: params.candidate.packageManifest.channel.blurb }
                        : {}),
                    ...(params.candidate.packageManifest.channel.preferOver
                        ? { preferOver: params.candidate.packageManifest.channel.preferOver }
                        : {}),
                },
            }
            : {}),
    };
}
function buildBundleRecord(params) {
    return {
        id: params.manifest.id,
        name: normalizeOptionalString(params.manifest.name) ?? params.candidate.idHint,
        description: normalizeOptionalString(params.manifest.description),
        version: normalizeOptionalString(params.manifest.version),
        format: "bundle",
        bundleFormat: params.candidate.bundleFormat,
        bundleCapabilities: params.manifest.capabilities,
        channels: [],
        providers: [],
        cliBackends: [],
        syntheticAuthRefs: [],
        nonSecretAuthMarkers: [],
        skills: params.manifest.skills ?? [],
        settingsFiles: params.manifest.settingsFiles ?? [],
        hooks: params.manifest.hooks ?? [],
        origin: params.candidate.origin,
        workspaceDir: params.candidate.workspaceDir,
        rootDir: params.candidate.rootDir,
        source: params.candidate.source,
        manifestPath: params.manifestPath,
        schemaCacheKey: undefined,
        configSchema: undefined,
        configUiHints: undefined,
        configContracts: undefined,
        channelConfigs: undefined,
    };
}
function pushProviderAuthEnvVarsCompatDiagnostic(params) {
    if (params.record.origin === "bundled" || !params.record.providerAuthEnvVars) {
        return;
    }
    const providerIds = Object.entries(params.record.providerAuthEnvVars)
        .filter(([providerId, envVars]) => providerId.trim() && envVars.length > 0)
        .map(([providerId]) => providerId)
        .toSorted((left, right) => left.localeCompare(right));
    if (providerIds.length === 0) {
        return;
    }
    params.diagnostics.push({
        level: "warn",
        pluginId: sanitizeForLog(params.record.id),
        source: sanitizeForLog(params.record.manifestPath),
        message: `providerAuthEnvVars is deprecated compatibility metadata for provider env-var lookup; mirror ${providerIds.map(sanitizeForLog).join(", ")} env vars to setup.providers[].envVars before the deprecation window closes`,
    });
}
function pushNonBundledChannelConfigDescriptorDiagnostic(params) {
    if (params.record.origin === "bundled" || params.record.format === "bundle") {
        return;
    }
    const declaredChannels = params.record.channels
        .map((channelId) => channelId.trim())
        .filter((channelId) => channelId.length > 0);
    if (declaredChannels.length === 0) {
        return;
    }
    const channelConfigs = params.record.channelConfigs ?? {};
    const missingChannels = declaredChannels.filter((channelId) => !Object.prototype.hasOwnProperty.call(channelConfigs, channelId));
    if (missingChannels.length === 0) {
        return;
    }
    const safeMissingChannels = missingChannels.map(sanitizeForLog);
    params.diagnostics.push({
        level: "warn",
        pluginId: sanitizeForLog(params.record.id),
        source: sanitizeForLog(params.record.manifestPath),
        message: `channel plugin manifest declares ${safeMissingChannels.join(", ")} without channelConfigs metadata; add openclaw.plugin.json#channelConfigs so config schema and setup surfaces work before runtime loads`,
    });
}
function pushManifestCompatibilityDiagnostics(params) {
    pushProviderAuthEnvVarsCompatDiagnostic(params);
    pushNonBundledChannelConfigDescriptorDiagnostic(params);
}
function matchesInstalledPluginRecord(params) {
    if (params.candidate.origin !== "global") {
        return false;
    }
    const record = loadPluginInstallRecordsSync({
        config: params.config,
        env: params.env,
    })[params.pluginId];
    if (!record) {
        return false;
    }
    const candidateSource = resolveUserPath(params.candidate.source, params.env);
    const trackedPaths = [record.installPath, record.sourcePath]
        .filter((entry) => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => resolveUserPath(entry, params.env));
    if (trackedPaths.length === 0) {
        return false;
    }
    return trackedPaths.some((trackedPath) => {
        return candidateSource === trackedPath || isPathInside(trackedPath, candidateSource);
    });
}
function resolveDuplicatePrecedenceRank(params) {
    if (params.candidate.origin === "config") {
        return 0;
    }
    if (params.candidate.origin === "global" &&
        matchesInstalledPluginRecord({
            pluginId: params.pluginId,
            candidate: params.candidate,
            config: params.config,
            env: params.env,
        })) {
        return 1;
    }
    if (params.candidate.origin === "bundled") {
        // Bundled plugin ids are reserved unless the operator explicitly overrides them.
        return 2;
    }
    if (params.candidate.origin === "workspace") {
        return 3;
    }
    return 4;
}
export function loadPluginManifestRegistry(params = {}) {
    const config = params.config ?? {};
    const normalized = normalizePluginsConfigWithResolver(config.plugins);
    const env = params.env ?? process.env;
    const cacheKey = buildCacheKey({ workspaceDir: params.workspaceDir, plugins: normalized, env });
    const cacheEnabled = params.cache !== false && shouldUseManifestCache(env);
    if (cacheEnabled) {
        const cached = registryCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.registry;
        }
    }
    const discovery = params.candidates
        ? {
            candidates: params.candidates,
            diagnostics: params.diagnostics ?? [],
        }
        : discoverOpenClawPlugins({
            workspaceDir: params.workspaceDir,
            extraPaths: normalized.loadPaths,
            cache: params.cache,
            env,
        });
    const diagnostics = [...discovery.diagnostics];
    const candidates = discovery.candidates;
    const records = [];
    const seenIds = new Map();
    const realpathCache = new Map();
    const currentHostVersion = resolveCompatibilityHostVersion(env);
    for (const candidate of candidates) {
        const rejectHardlinks = candidate.origin !== "bundled";
        const isBundleRecord = (candidate.format ?? "openclaw") === "bundle";
        const manifestRes = candidate.origin === "bundled" && candidate.bundledManifest && candidate.bundledManifestPath
            ? {
                ok: true,
                manifest: candidate.bundledManifest,
                manifestPath: candidate.bundledManifestPath,
            }
            : isBundleRecord && candidate.bundleFormat
                ? loadBundleManifest({
                    rootDir: candidate.rootDir,
                    bundleFormat: candidate.bundleFormat,
                    rejectHardlinks,
                })
                : loadPluginManifest(candidate.rootDir, rejectHardlinks);
        if (!manifestRes.ok) {
            diagnostics.push({
                level: "error",
                message: manifestRes.error,
                source: manifestRes.manifestPath,
            });
            continue;
        }
        const manifest = manifestRes.manifest;
        const minHostVersionCheck = checkMinHostVersion({
            currentVersion: currentHostVersion,
            minHostVersion: candidate.packageManifest?.install?.minHostVersion,
        });
        if (!minHostVersionCheck.ok) {
            const packageManifestSource = path.join(candidate.packageDir ?? candidate.rootDir, "package.json");
            diagnostics.push({
                level: minHostVersionCheck.kind === "unknown_host_version" ? "warn" : "error",
                pluginId: manifest.id,
                source: packageManifestSource,
                message: minHostVersionCheck.kind === "invalid"
                    ? `plugin manifest invalid | ${minHostVersionCheck.error}`
                    : minHostVersionCheck.kind === "unknown_host_version"
                        ? `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined; skipping load`
                        : `plugin requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}; skipping load`,
            });
            continue;
        }
        const configSchema = "configSchema" in manifest ? manifest.configSchema : undefined;
        const schemaCacheKey = (() => {
            if (!configSchema) {
                return undefined;
            }
            const manifestMtime = safeStatMtimeMs(manifestRes.manifestPath);
            return manifestMtime
                ? `${manifestRes.manifestPath}:${manifestMtime}`
                : manifestRes.manifestPath;
        })();
        const record = isBundleRecord
            ? buildBundleRecord({
                manifest: manifest,
                candidate,
                manifestPath: manifestRes.manifestPath,
            })
            : buildRecord({
                manifest: manifest,
                candidate,
                manifestPath: manifestRes.manifestPath,
                schemaCacheKey,
                configSchema,
            });
        const existing = seenIds.get(manifest.id);
        if (existing) {
            // Check whether both candidates point to the same physical directory
            // (e.g. via symlinks or different path representations). If so, this
            // is a false-positive duplicate and can be silently skipped.
            const samePath = existing.candidate.rootDir === candidate.rootDir;
            const samePlugin = (() => {
                if (samePath) {
                    return true;
                }
                const existingReal = safeRealpathSync(existing.candidate.rootDir, realpathCache);
                const candidateReal = safeRealpathSync(candidate.rootDir, realpathCache);
                return Boolean(existingReal && candidateReal && existingReal === candidateReal);
            })();
            if (samePlugin) {
                // Prefer higher-precedence origins even if candidates are passed in
                // an unexpected order (config > workspace > global > bundled).
                if (PLUGIN_ORIGIN_RANK[candidate.origin] < PLUGIN_ORIGIN_RANK[existing.candidate.origin]) {
                    records[existing.recordIndex] = record;
                    seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
                    pushManifestCompatibilityDiagnostics({ record, diagnostics });
                }
                continue;
            }
            const candidateRank = resolveDuplicatePrecedenceRank({
                pluginId: manifest.id,
                candidate,
                config,
                env,
            });
            const existingRank = resolveDuplicatePrecedenceRank({
                pluginId: manifest.id,
                candidate: existing.candidate,
                config,
                env,
            });
            const candidateWins = candidateRank < existingRank;
            const winnerCandidate = candidateWins ? candidate : existing.candidate;
            const overriddenCandidate = candidateWins ? existing.candidate : candidate;
            if (candidateWins) {
                records[existing.recordIndex] = record;
                seenIds.set(manifest.id, { candidate, recordIndex: existing.recordIndex });
                pushManifestCompatibilityDiagnostics({ record, diagnostics });
            }
            diagnostics.push({
                level: "warn",
                pluginId: manifest.id,
                source: overriddenCandidate.source,
                message: `duplicate plugin id detected; ${overriddenCandidate.origin} plugin will be overridden by ${winnerCandidate.origin} plugin (${winnerCandidate.source})`,
            });
            continue;
        }
        seenIds.set(manifest.id, { candidate, recordIndex: records.length });
        records.push(record);
        pushManifestCompatibilityDiagnostics({ record, diagnostics });
    }
    const registry = { plugins: records, diagnostics };
    if (cacheEnabled) {
        const ttl = resolveManifestCacheMs(env);
        if (ttl > 0) {
            registryCache.set(cacheKey, { expiresAt: Date.now() + ttl, registry });
        }
    }
    return registry;
}
