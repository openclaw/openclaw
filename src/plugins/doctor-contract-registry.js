import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asNullableRecord } from "../shared/record-coerce.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { tryNativeRequireJavaScriptModule } from "./native-module-require.js";
import { resolvePluginCacheInputs } from "./roots.js";
const CONTRACT_API_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"];
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const RUNNING_FROM_BUILT_ARTIFACT = CURRENT_MODULE_PATH.includes(`${path.sep}dist${path.sep}`) ||
    CURRENT_MODULE_PATH.includes(`${path.sep}dist-runtime${path.sep}`);
const jitiLoaders = new Map();
const doctorContractCache = new Map();
const doctorContractRecordCache = new Map();
function getJiti(modulePath) {
    return getCachedPluginJitiLoader({
        cache: jitiLoaders,
        modulePath,
        importerUrl: import.meta.url,
    });
}
function loadPluginDoctorContractModule(modulePath) {
    const nativeModule = tryNativeRequireJavaScriptModule(modulePath);
    if (nativeModule.ok) {
        return nativeModule.moduleExport;
    }
    return getJiti(modulePath)(modulePath);
}
function buildDoctorContractCacheKey(params) {
    return JSON.stringify({
        ...resolveDoctorContractBaseCachePayload(params),
        pluginIds: [...(params.pluginIds ?? [])].toSorted(),
    });
}
function buildDoctorContractBaseCacheKey(params) {
    return JSON.stringify(resolveDoctorContractBaseCachePayload(params));
}
function resolveDoctorContractBaseCachePayload(params) {
    const { roots, loadPaths } = resolvePluginCacheInputs({
        workspaceDir: params.workspaceDir,
        env: params.env,
    });
    return { roots, loadPaths };
}
function resolveContractApiPath(rootDir) {
    const orderedExtensions = RUNNING_FROM_BUILT_ARTIFACT
        ? CONTRACT_API_EXTENSIONS
        : [...CONTRACT_API_EXTENSIONS.slice(3), ...CONTRACT_API_EXTENSIONS.slice(0, 3)];
    for (const extension of orderedExtensions) {
        const candidate = path.join(rootDir, `doctor-contract-api${extension}`);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    for (const extension of orderedExtensions) {
        const candidate = path.join(rootDir, `contract-api${extension}`);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return null;
}
function coerceLegacyConfigRules(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => {
        if (!entry || typeof entry !== "object") {
            return false;
        }
        const candidate = entry;
        return Array.isArray(candidate.path) && typeof candidate.message === "string";
    });
}
function coerceNormalizeCompatibilityConfig(value) {
    return typeof value === "function" ? value : undefined;
}
function hasLegacyElevenLabsTalkFields(raw) {
    const talk = asNullableRecord(asNullableRecord(raw)?.talk);
    if (!talk) {
        return false;
    }
    return ["voiceId", "voiceAliases", "modelId", "outputFormat", "apiKey"].some((key) => Object.prototype.hasOwnProperty.call(talk, key));
}
export function collectRelevantDoctorPluginIds(raw) {
    const ids = new Set();
    const root = asNullableRecord(raw);
    if (!root) {
        return [];
    }
    const channels = asNullableRecord(root.channels);
    if (channels) {
        for (const channelId of Object.keys(channels)) {
            if (channelId !== "defaults") {
                ids.add(channelId);
            }
        }
    }
    const pluginsEntries = asNullableRecord(asNullableRecord(root.plugins)?.entries);
    if (pluginsEntries) {
        for (const pluginId of Object.keys(pluginsEntries)) {
            ids.add(pluginId);
        }
    }
    if (hasLegacyElevenLabsTalkFields(root)) {
        ids.add("elevenlabs");
    }
    return [...ids].toSorted();
}
export function collectRelevantDoctorPluginIdsForTouchedPaths(params) {
    const root = asNullableRecord(params.raw);
    if (!root) {
        return [];
    }
    const ids = new Set();
    for (const touchedPath of params.touchedPaths) {
        const [first, second, third] = touchedPath;
        if (first === "channels") {
            if (!second) {
                return collectRelevantDoctorPluginIds(params.raw);
            }
            if (second !== "defaults") {
                ids.add(second);
            }
            continue;
        }
        if (first === "plugins") {
            if (second !== "entries" || !third) {
                return collectRelevantDoctorPluginIds(params.raw);
            }
            ids.add(third);
            continue;
        }
        if (first === "talk" && hasLegacyElevenLabsTalkFields(root)) {
            ids.add("elevenlabs");
        }
    }
    return [...ids].toSorted();
}
function getDoctorContractRecordCache(baseCacheKey) {
    let cache = doctorContractRecordCache.get(baseCacheKey);
    if (!cache) {
        cache = new Map();
        doctorContractRecordCache.set(baseCacheKey, cache);
    }
    return cache;
}
function loadPluginDoctorContractEntry(record, baseCacheKey) {
    const cache = getDoctorContractRecordCache(baseCacheKey);
    const cached = cache.get(record.id);
    if (cached !== undefined) {
        return cached;
    }
    const contractSource = resolveContractApiPath(record.rootDir);
    if (!contractSource) {
        cache.set(record.id, null);
        return null;
    }
    let mod;
    try {
        mod = loadPluginDoctorContractModule(contractSource);
    }
    catch {
        cache.set(record.id, null);
        return null;
    }
    const rules = coerceLegacyConfigRules(mod.default?.legacyConfigRules ??
        mod.legacyConfigRules);
    const normalizeCompatibilityConfig = coerceNormalizeCompatibilityConfig(mod.normalizeCompatibilityConfig ??
        mod.default?.normalizeCompatibilityConfig);
    if (rules.length === 0 && !normalizeCompatibilityConfig) {
        cache.set(record.id, null);
        return null;
    }
    const entry = {
        pluginId: record.id,
        rules,
        normalizeCompatibilityConfig,
    };
    cache.set(record.id, entry);
    return entry;
}
function resolvePluginDoctorContracts(params) {
    const env = params?.env ?? process.env;
    const baseCacheKey = buildDoctorContractBaseCacheKey({
        workspaceDir: params?.workspaceDir,
        env,
    });
    const cacheKey = buildDoctorContractCacheKey({
        workspaceDir: params?.workspaceDir,
        env,
        pluginIds: params?.pluginIds,
    });
    const cached = doctorContractCache.get(cacheKey);
    if (cached) {
        return cached;
    }
    if (params?.pluginIds && params.pluginIds.length === 0) {
        doctorContractCache.set(cacheKey, []);
        return [];
    }
    const discovery = discoverOpenClawPlugins({
        workspaceDir: params?.workspaceDir,
        env,
        cache: true,
    });
    const manifestRegistry = loadPluginManifestRegistry({
        workspaceDir: params?.workspaceDir,
        env,
        cache: true,
        candidates: discovery.candidates,
        diagnostics: discovery.diagnostics,
    });
    const entries = [];
    const selectedPluginIds = params?.pluginIds ? new Set(params.pluginIds) : null;
    for (const record of manifestRegistry.plugins) {
        if (selectedPluginIds &&
            !selectedPluginIds.has(record.id) &&
            !record.channels.some((channelId) => selectedPluginIds.has(channelId)) &&
            !record.providers.some((providerId) => selectedPluginIds.has(providerId))) {
            continue;
        }
        const entry = loadPluginDoctorContractEntry(record, baseCacheKey);
        if (entry) {
            entries.push(entry);
        }
    }
    doctorContractCache.set(cacheKey, entries);
    return entries;
}
export function clearPluginDoctorContractRegistryCache() {
    doctorContractCache.clear();
    doctorContractRecordCache.clear();
    jitiLoaders.clear();
}
export function listPluginDoctorLegacyConfigRules(params) {
    return resolvePluginDoctorContracts(params).flatMap((entry) => entry.rules);
}
export function applyPluginDoctorCompatibilityMigrations(cfg, params) {
    let nextCfg = cfg;
    const changes = [];
    for (const entry of resolvePluginDoctorContracts(params)) {
        const mutation = entry.normalizeCompatibilityConfig?.({ cfg: nextCfg });
        if (!mutation || mutation.changes.length === 0) {
            continue;
        }
        nextCfg = mutation.config;
        changes.push(...mutation.changes);
    }
    return { config: nextCfg, changes };
}
