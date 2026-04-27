import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeProviderId } from "../agents/provider-id.js";
import { buildPluginApi } from "./api-builder.js";
import { collectPluginConfigContractMatches } from "./config-contracts.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { resolvePluginCacheInputs } from "./roots.js";
import { listSetupCliBackendIds, listSetupProviderIds } from "./setup-descriptors.js";
const SETUP_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
    CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const EMPTY_RUNTIME = {};
const NOOP_LOGGER = {
    info() { },
    warn() { },
    error() { },
};
const MAX_SETUP_LOOKUP_CACHE_ENTRIES = 128;
const jitiLoaders = new Map();
const setupRegistryCache = new Map();
const setupProviderCache = new Map();
const setupCliBackendCache = new Map();
let setupLookupCacheEntryCap = MAX_SETUP_LOOKUP_CACHE_ENTRIES;
export const __testing = {
    get maxSetupLookupCacheEntries() {
        return setupLookupCacheEntryCap;
    },
    setMaxSetupLookupCacheEntriesForTest(value) {
        setupLookupCacheEntryCap =
            typeof value === "number" && Number.isFinite(value) && value > 0
                ? Math.max(1, Math.floor(value))
                : MAX_SETUP_LOOKUP_CACHE_ENTRIES;
    },
    getCacheSizes() {
        return {
            setupRegistry: setupRegistryCache.size,
            setupProvider: setupProviderCache.size,
            setupCliBackend: setupCliBackendCache.size,
        };
    },
};
export function clearPluginSetupRegistryCache() {
    jitiLoaders.clear();
    setupRegistryCache.clear();
    setupProviderCache.clear();
    setupCliBackendCache.clear();
}
function getJiti(modulePath) {
    return getCachedPluginJitiLoader({
        cache: jitiLoaders,
        modulePath,
        importerUrl: import.meta.url,
    });
}
function getCachedSetupValue(cache, key) {
    if (!cache.has(key)) {
        return { hit: false };
    }
    const cached = cache.get(key);
    cache.delete(key);
    cache.set(key, cached);
    return { hit: true, value: cached };
}
function setCachedSetupValue(cache, key, value) {
    if (cache.has(key)) {
        cache.delete(key);
    }
    cache.set(key, value);
    while (cache.size > setupLookupCacheEntryCap) {
        const oldestKey = cache.keys().next().value;
        if (typeof oldestKey !== "string") {
            break;
        }
        cache.delete(oldestKey);
    }
}
function buildSetupRegistryCacheKey(params) {
    const { roots, loadPaths } = resolvePluginCacheInputs({
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
    return JSON.stringify({
        roots,
        loadPaths,
        pluginIds: params.pluginIds ? [...new Set(params.pluginIds)].toSorted() : null,
    });
}
function buildSetupProviderCacheKey(params) {
    return JSON.stringify({
        provider: normalizeProviderId(params.provider),
        registry: buildSetupRegistryCacheKey(params),
    });
}
function buildSetupCliBackendCacheKey(params) {
    return JSON.stringify({
        backend: normalizeProviderId(params.backend),
        registry: buildSetupRegistryCacheKey(params),
    });
}
function resolveSetupApiPath(rootDir, options) {
    const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
        ? SETUP_API_EXTENSIONS
        : [...SETUP_API_EXTENSIONS.slice(3), ...SETUP_API_EXTENSIONS.slice(0, 3)];
    const findSetupApi = (candidateRootDir) => {
        for (const extension of orderedExtensions) {
            const candidate = path.join(candidateRootDir, `setup-api${extension}`);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        return null;
    };
    const direct = findSetupApi(rootDir);
    if (direct) {
        return direct;
    }
    if (options?.includeBundledSourceFallback === false) {
        return null;
    }
    const bundledExtensionDir = path.basename(rootDir);
    const repoRootCandidates = [path.resolve(path.dirname(CURRENT_MODULE_PATH), "..", "..")];
    for (const repoRoot of repoRootCandidates) {
        const sourceExtensionRoot = path.join(repoRoot, "extensions", bundledExtensionDir);
        if (sourceExtensionRoot === rootDir) {
            continue;
        }
        const sourceFallback = findSetupApi(sourceExtensionRoot);
        if (sourceFallback) {
            return sourceFallback;
        }
    }
    return null;
}
function collectConfiguredPluginEntryIds(config) {
    const entries = config.plugins?.entries;
    if (!entries || typeof entries !== "object") {
        return [];
    }
    return Object.keys(entries)
        .map((pluginId) => pluginId.trim())
        .filter(Boolean)
        .toSorted();
}
function resolveRelevantSetupMigrationPluginIds(params) {
    const ids = new Set(collectConfiguredPluginEntryIds(params.config));
    const registry = loadPluginManifestRegistry({
        workspaceDir: params.workspaceDir,
        env: params.env,
        cache: true,
    });
    for (const plugin of registry.plugins) {
        const paths = plugin.configContracts?.compatibilityMigrationPaths;
        if (!paths?.length) {
            continue;
        }
        if (paths.some((pathPattern) => collectPluginConfigContractMatches({
            root: params.config,
            pathPattern,
        }).length > 0)) {
            ids.add(plugin.id);
        }
    }
    return [...ids].toSorted();
}
function resolveRegister(mod) {
    if (typeof mod === "function") {
        return { register: mod };
    }
    if (mod && typeof mod === "object" && typeof mod.register === "function") {
        return {
            definition: mod,
            register: mod.register.bind(mod),
        };
    }
    return {};
}
function resolveLoadableSetupRuntimeSource(record) {
    return record.setupSource ?? resolveSetupApiPath(record.rootDir);
}
function resolveDeclaredSetupRuntimeSource(record) {
    return (record.setupSource ??
        resolveSetupApiPath(record.rootDir, {
            includeBundledSourceFallback: false,
        }));
}
function resolveSetupRegistration(record) {
    if (record.setup?.requiresRuntime === false) {
        return null;
    }
    const setupSource = resolveLoadableSetupRuntimeSource(record);
    if (!setupSource) {
        return null;
    }
    let mod;
    try {
        mod = getJiti(setupSource)(setupSource);
    }
    catch {
        return null;
    }
    const resolved = resolveRegister(mod.default ?? mod);
    if (!resolved.register) {
        return null;
    }
    if (resolved.definition?.id && resolved.definition.id !== record.id) {
        return null;
    }
    return {
        setupSource,
        register: resolved.register,
    };
}
function buildSetupPluginApi(params) {
    return buildPluginApi({
        id: params.record.id,
        name: params.record.name ?? params.record.id,
        version: params.record.version,
        description: params.record.description,
        source: params.setupSource,
        rootDir: params.record.rootDir,
        registrationMode: "setup-only",
        config: {},
        runtime: EMPTY_RUNTIME,
        logger: NOOP_LOGGER,
        resolvePath: (input) => input,
        handlers: params.handlers,
    });
}
function ignoreAsyncSetupRegisterResult(result) {
    if (!result || typeof result.then !== "function") {
        return;
    }
    // Setup-only registration is sync-only. Swallow async rejections so they do
    // not trip the global unhandledRejection fatal path.
    void Promise.resolve(result).catch(() => undefined);
}
function matchesProvider(provider, providerId) {
    const normalized = normalizeProviderId(providerId);
    if (normalizeProviderId(provider.id) === normalized) {
        return true;
    }
    return [...(provider.aliases ?? []), ...(provider.hookAliases ?? [])].some((alias) => normalizeProviderId(alias) === normalized);
}
function loadSetupManifestRegistry(params) {
    const env = params?.env ?? process.env;
    const discovery = discoverOpenClawPlugins({
        workspaceDir: params?.workspaceDir,
        env,
        cache: true,
    });
    return loadPluginManifestRegistry({
        workspaceDir: params?.workspaceDir,
        env,
        cache: true,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
    });
}
function findUniqueSetupManifestOwner(params) {
    const matches = params.registry.plugins.filter((entry) => params.listIds(entry).some((id) => normalizeProviderId(id) === params.normalizedId));
    if (matches.length === 0) {
        return undefined;
    }
    // Setup lookup can execute plugin code. Refuse ambiguous ownership instead of
    // depending on manifest ordering across bundled/workspace/global sources.
    return matches.length === 1 ? matches[0] : undefined;
}
function mapNormalizedIds(ids) {
    const mapped = new Map();
    for (const id of ids) {
        const normalized = normalizeProviderId(id);
        if (!normalized || mapped.has(normalized)) {
            continue;
        }
        mapped.set(normalized, id);
    }
    return mapped;
}
function pushDescriptorRuntimeDisabledDiagnostic(params) {
    if (!resolveDeclaredSetupRuntimeSource(params.record)) {
        return;
    }
    params.diagnostics.push({
        pluginId: params.record.id,
        code: "setup-descriptor-runtime-disabled",
        message: "setup.requiresRuntime is false, so OpenClaw ignored the plugin setup runtime entry. Remove setup-api/openclaw.setupEntry or set requiresRuntime true if setup lookup still needs plugin code.",
    });
}
function pushSetupDescriptorDriftDiagnostics(params) {
    const declaredProviderIds = params.record.setup?.providers?.map((entry) => entry.id);
    if (declaredProviderIds) {
        for (const declaredId of declaredProviderIds) {
            if (!params.providers.some((provider) => matchesProvider(provider, declaredId))) {
                params.diagnostics.push({
                    pluginId: params.record.id,
                    code: "setup-descriptor-provider-missing-runtime",
                    declaredId,
                    message: `setup.providers declares "${declaredId}" but setup runtime did not register a matching provider.`,
                });
            }
        }
        for (const provider of params.providers) {
            if (!declaredProviderIds.some((declaredId) => matchesProvider(provider, declaredId))) {
                params.diagnostics.push({
                    pluginId: params.record.id,
                    code: "setup-descriptor-provider-runtime-undeclared",
                    runtimeId: provider.id,
                    message: `setup runtime registered provider "${provider.id}" but setup.providers does not declare it.`,
                });
            }
        }
    }
    const declaredCliBackendIds = params.record.setup?.cliBackends;
    if (declaredCliBackendIds) {
        const declaredCliBackends = mapNormalizedIds(declaredCliBackendIds);
        const runtimeCliBackends = mapNormalizedIds(params.cliBackends.map((backend) => backend.id));
        for (const [normalized, declaredId] of declaredCliBackends) {
            if (!runtimeCliBackends.has(normalized)) {
                params.diagnostics.push({
                    pluginId: params.record.id,
                    code: "setup-descriptor-cli-backend-missing-runtime",
                    declaredId,
                    message: `setup.cliBackends declares "${declaredId}" but setup runtime did not register a matching CLI backend.`,
                });
            }
        }
        for (const [normalized, runtimeId] of runtimeCliBackends) {
            if (!declaredCliBackends.has(normalized)) {
                params.diagnostics.push({
                    pluginId: params.record.id,
                    code: "setup-descriptor-cli-backend-runtime-undeclared",
                    runtimeId,
                    message: `setup runtime registered CLI backend "${runtimeId}" but setup.cliBackends does not declare it.`,
                });
            }
        }
    }
}
export function resolvePluginSetupRegistry(params) {
    const env = params?.env ?? process.env;
    const cacheKey = buildSetupRegistryCacheKey({
        workspaceDir: params?.workspaceDir,
        env,
        pluginIds: params?.pluginIds,
    });
    const cached = getCachedSetupValue(setupRegistryCache, cacheKey);
    if (cached.hit) {
        return cached.value;
    }
    const selectedPluginIds = params?.pluginIds
        ? new Set(params.pluginIds.map((pluginId) => pluginId.trim()).filter(Boolean))
        : null;
    if (selectedPluginIds && selectedPluginIds.size === 0) {
        const empty = {
            providers: [],
            cliBackends: [],
            configMigrations: [],
            autoEnableProbes: [],
            diagnostics: [],
        };
        setCachedSetupValue(setupRegistryCache, cacheKey, empty);
        return empty;
    }
    const providers = [];
    const cliBackends = [];
    const configMigrations = [];
    const autoEnableProbes = [];
    const diagnostics = [];
    const providerKeys = new Set();
    const cliBackendKeys = new Set();
    const manifestRegistry = loadSetupManifestRegistry({
        workspaceDir: params?.workspaceDir,
        env,
    });
    for (const record of manifestRegistry.plugins) {
        if (selectedPluginIds && !selectedPluginIds.has(record.id)) {
            continue;
        }
        if (record.setup?.requiresRuntime === false) {
            pushDescriptorRuntimeDisabledDiagnostic({
                record,
                diagnostics,
            });
            continue;
        }
        const setupRegistration = resolveSetupRegistration(record);
        if (!setupRegistration) {
            continue;
        }
        const recordProviders = [];
        const recordCliBackends = [];
        const api = buildSetupPluginApi({
            record,
            setupSource: setupRegistration.setupSource,
            handlers: {
                registerProvider(provider) {
                    const key = `${record.id}:${normalizeProviderId(provider.id)}`;
                    if (providerKeys.has(key)) {
                        return;
                    }
                    providerKeys.add(key);
                    providers.push({
                        pluginId: record.id,
                        provider,
                    });
                    recordProviders.push(provider);
                },
                registerCliBackend(backend) {
                    const key = `${record.id}:${normalizeProviderId(backend.id)}`;
                    if (cliBackendKeys.has(key)) {
                        return;
                    }
                    cliBackendKeys.add(key);
                    cliBackends.push({
                        pluginId: record.id,
                        backend,
                    });
                    recordCliBackends.push(backend);
                },
                registerConfigMigration(migrate) {
                    configMigrations.push({
                        pluginId: record.id,
                        migrate,
                    });
                },
                registerAutoEnableProbe(probe) {
                    autoEnableProbes.push({
                        pluginId: record.id,
                        probe,
                    });
                },
            },
        });
        try {
            const result = setupRegistration.register(api);
            if (result && typeof result.then === "function") {
                // Keep setup registration sync-only.
                ignoreAsyncSetupRegisterResult(result);
            }
        }
        catch {
            continue;
        }
        pushSetupDescriptorDriftDiagnostics({
            record,
            providers: recordProviders,
            cliBackends: recordCliBackends,
            diagnostics,
        });
    }
    const registry = {
        providers,
        cliBackends,
        configMigrations,
        autoEnableProbes,
        diagnostics,
    };
    setCachedSetupValue(setupRegistryCache, cacheKey, registry);
    return registry;
}
export function resolvePluginSetupProvider(params) {
    const cacheKey = buildSetupProviderCacheKey(params);
    const cached = getCachedSetupValue(setupProviderCache, cacheKey);
    if (cached.hit) {
        return cached.value ?? undefined;
    }
    const env = params.env ?? process.env;
    const normalizedProvider = normalizeProviderId(params.provider);
    const manifestRegistry = loadSetupManifestRegistry({
        workspaceDir: params.workspaceDir,
        env,
    });
    const record = findUniqueSetupManifestOwner({
        registry: manifestRegistry,
        normalizedId: normalizedProvider,
        listIds: listSetupProviderIds,
    });
    if (!record) {
        setCachedSetupValue(setupProviderCache, cacheKey, null);
        return undefined;
    }
    const setupRegistration = resolveSetupRegistration(record);
    if (!setupRegistration) {
        setCachedSetupValue(setupProviderCache, cacheKey, null);
        return undefined;
    }
    let matchedProvider;
    const localProviderKeys = new Set();
    const api = buildSetupPluginApi({
        record,
        setupSource: setupRegistration.setupSource,
        handlers: {
            registerProvider(provider) {
                const key = normalizeProviderId(provider.id);
                if (localProviderKeys.has(key)) {
                    return;
                }
                localProviderKeys.add(key);
                if (matchesProvider(provider, normalizedProvider)) {
                    matchedProvider = provider;
                }
            },
            registerConfigMigration() { },
            registerAutoEnableProbe() { },
        },
    });
    try {
        const result = setupRegistration.register(api);
        if (result && typeof result.then === "function") {
            // Keep setup registration sync-only.
            ignoreAsyncSetupRegisterResult(result);
        }
    }
    catch {
        setCachedSetupValue(setupProviderCache, cacheKey, null);
        return undefined;
    }
    setCachedSetupValue(setupProviderCache, cacheKey, matchedProvider ?? null);
    return matchedProvider;
}
export function resolvePluginSetupCliBackend(params) {
    const cacheKey = buildSetupCliBackendCacheKey(params);
    const cached = getCachedSetupValue(setupCliBackendCache, cacheKey);
    if (cached.hit) {
        return cached.value ?? undefined;
    }
    const normalized = normalizeProviderId(params.backend);
    const env = params.env ?? process.env;
    // Narrow setup lookup from manifest-owned descriptors before executing any
    // plugin setup module. This avoids booting every setup-api just to find one
    // backend owner.
    const manifestRegistry = loadSetupManifestRegistry({
        workspaceDir: params.workspaceDir,
        env,
    });
    const record = findUniqueSetupManifestOwner({
        registry: manifestRegistry,
        normalizedId: normalized,
        listIds: listSetupCliBackendIds,
    });
    if (!record) {
        setCachedSetupValue(setupCliBackendCache, cacheKey, null);
        return undefined;
    }
    const setupRegistration = resolveSetupRegistration(record);
    if (!setupRegistration) {
        setCachedSetupValue(setupCliBackendCache, cacheKey, null);
        return undefined;
    }
    let matchedBackend;
    const localBackendKeys = new Set();
    const api = buildSetupPluginApi({
        record,
        setupSource: setupRegistration.setupSource,
        handlers: {
            registerProvider() { },
            registerConfigMigration() { },
            registerAutoEnableProbe() { },
            registerCliBackend(backend) {
                const key = normalizeProviderId(backend.id);
                if (localBackendKeys.has(key)) {
                    return;
                }
                localBackendKeys.add(key);
                if (key === normalized) {
                    matchedBackend = backend;
                }
            },
        },
    });
    try {
        const result = setupRegistration.register(api);
        if (result && typeof result.then === "function") {
            // Keep setup registration sync-only.
            ignoreAsyncSetupRegisterResult(result);
        }
    }
    catch {
        setCachedSetupValue(setupCliBackendCache, cacheKey, null);
        return undefined;
    }
    const resolvedEntry = matchedBackend ? { pluginId: record.id, backend: matchedBackend } : null;
    setCachedSetupValue(setupCliBackendCache, cacheKey, resolvedEntry);
    return resolvedEntry ?? undefined;
}
export function runPluginSetupConfigMigrations(params) {
    let next = params.config;
    const changes = [];
    const pluginIds = resolveRelevantSetupMigrationPluginIds(params);
    if (pluginIds.length === 0) {
        return { config: next, changes };
    }
    for (const entry of resolvePluginSetupRegistry({
        workspaceDir: params.workspaceDir,
        env: params.env,
        pluginIds,
    }).configMigrations) {
        const migration = entry.migrate(next);
        if (!migration || migration.changes.length === 0) {
            continue;
        }
        next = migration.config;
        changes.push(...migration.changes);
    }
    return { config: next, changes };
}
export function resolvePluginSetupAutoEnableReasons(params) {
    const env = params.env ?? process.env;
    const reasons = [];
    const seen = new Set();
    for (const entry of resolvePluginSetupRegistry({
        workspaceDir: params.workspaceDir,
        env,
        pluginIds: params.pluginIds,
    }).autoEnableProbes) {
        const raw = entry.probe({
            config: params.config,
            env,
        });
        const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
        for (const reason of values) {
            const normalized = reason.trim();
            if (!normalized) {
                continue;
            }
            const key = `${entry.pluginId}:${normalized}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            reasons.push({
                pluginId: entry.pluginId,
                reason: normalized,
            });
        }
    }
    return reasons;
}
