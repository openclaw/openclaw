import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { getCachedPluginJitiLoader, } from "../plugins/jiti-loader-cache.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import { loadBundledPluginPublicSurfaceModuleSync as loadBundledPluginPublicSurfaceModuleSyncLight, loadFacadeModuleAtLocationSync as loadFacadeModuleAtLocationSyncShared, resetFacadeLoaderStateForTest, } from "./facade-loader.js";
import { createFacadeResolutionKey as createFacadeResolutionKeyShared, resolveBundledFacadeModuleLocation, resolveCachedFacadeModuleLocation, resolveRegistryPluginModuleLocationFromRecords, } from "./facade-resolution-shared.js";
export { createLazyFacadeArrayValue, createLazyFacadeObjectValue, listImportedBundledPluginFacadeIds, } from "./facade-loader.js";
export function createLazyFacadeValue(loadFacadeModule, key) {
    return ((...args) => {
        const value = loadFacadeModule()[key];
        if (typeof value !== "function") {
            return value;
        }
        return value(...args);
    });
}
const OPENCLAW_PACKAGE_ROOT = resolveLoaderPackageRoot({
    modulePath: fileURLToPath(import.meta.url),
    moduleUrl: import.meta.url,
}) ?? fileURLToPath(new URL("../..", import.meta.url));
const CURRENT_MODULE_PATH = fileURLToPath(import.meta.url);
const OPENCLAW_SOURCE_EXTENSIONS_ROOT = path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions");
const cachedFacadeModuleLocationsByKey = new Map();
function createFacadeResolutionKey(params) {
    const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
    return createFacadeResolutionKeyShared({ ...params, bundledPluginsDir });
}
function resolveRegistryPluginModuleLocation(params) {
    return loadFacadeActivationCheckRuntime().resolveRegistryPluginModuleLocation({
        ...params,
        resolutionKey: createFacadeResolutionKey(params),
    });
}
function resolveFacadeModuleLocationUncached(params) {
    const bundledPluginsDir = resolveBundledPluginsDir(params.env ?? process.env);
    const bundledLocation = resolveBundledFacadeModuleLocation({
        ...params,
        currentModulePath: CURRENT_MODULE_PATH,
        packageRoot: OPENCLAW_PACKAGE_ROOT,
        bundledPluginsDir,
    });
    if (bundledLocation) {
        return bundledLocation;
    }
    return resolveRegistryPluginModuleLocation(params);
}
function resolveFacadeModuleLocation(params) {
    return resolveCachedFacadeModuleLocation({
        cache: cachedFacadeModuleLocationsByKey,
        key: createFacadeResolutionKey(params),
        resolve: () => resolveFacadeModuleLocationUncached(params),
    });
}
const nodeRequire = createRequire(import.meta.url);
const FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES = [
    "./facade-activation-check.runtime.js",
    "./facade-activation-check.runtime.ts",
];
let facadeActivationCheckRuntimeModule;
const facadeActivationCheckRuntimeJitiLoaders = new Map();
function getFacadeActivationCheckRuntimeJiti(modulePath) {
    return getCachedPluginJitiLoader({
        cache: facadeActivationCheckRuntimeJitiLoaders,
        modulePath,
        importerUrl: import.meta.url,
        jitiFilename: import.meta.url,
        aliasMap: {},
        tryNative: false,
    });
}
function loadFacadeActivationCheckRuntimeFromCandidates(loadCandidate) {
    for (const candidate of FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES) {
        try {
            return loadCandidate(candidate);
        }
        catch {
            // Try source/runtime candidates in order.
        }
    }
    return undefined;
}
function loadFacadeActivationCheckRuntime() {
    if (facadeActivationCheckRuntimeModule) {
        return facadeActivationCheckRuntimeModule;
    }
    facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) => nodeRequire(candidate));
    if (facadeActivationCheckRuntimeModule) {
        return facadeActivationCheckRuntimeModule;
    }
    facadeActivationCheckRuntimeModule = loadFacadeActivationCheckRuntimeFromCandidates((candidate) => getFacadeActivationCheckRuntimeJiti(candidate)(candidate));
    if (facadeActivationCheckRuntimeModule) {
        return facadeActivationCheckRuntimeModule;
    }
    throw new Error("Unable to load facade activation check runtime");
}
function loadFacadeModuleAtLocationSync(params) {
    return loadFacadeModuleAtLocationSyncShared(params);
}
function buildFacadeActivationCheckParams(params, location = resolveFacadeModuleLocation(params)) {
    return {
        ...params,
        location,
        sourceExtensionsRoot: OPENCLAW_SOURCE_EXTENSIONS_ROOT,
        resolutionKey: createFacadeResolutionKey(params),
    };
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadBundledPluginPublicSurfaceModuleSync(params) {
    const location = resolveFacadeModuleLocation(params);
    const trackedPluginId = () => loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(buildFacadeActivationCheckParams(params, location));
    if (!location) {
        return loadBundledPluginPublicSurfaceModuleSyncLight({
            ...params,
            trackedPluginId,
        });
    }
    return loadFacadeModuleAtLocationSync({
        location,
        trackedPluginId,
    });
}
export function canLoadActivatedBundledPluginPublicSurface(params) {
    return loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(buildFacadeActivationCheckParams(params)).allowed;
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function loadActivatedBundledPluginPublicSurfaceModuleSync(params) {
    loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(buildFacadeActivationCheckParams(params));
    return loadBundledPluginPublicSurfaceModuleSync(params);
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic facade loaders use caller-supplied module surface types.
export function tryLoadActivatedBundledPluginPublicSurfaceModuleSync(params) {
    const access = loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(buildFacadeActivationCheckParams(params));
    if (!access.allowed) {
        return null;
    }
    return loadBundledPluginPublicSurfaceModuleSync(params);
}
export function resetFacadeRuntimeStateForTest() {
    resetFacadeLoaderStateForTest();
    facadeActivationCheckRuntimeModule?.resetFacadeActivationCheckRuntimeStateForTest();
    facadeActivationCheckRuntimeModule = undefined;
    facadeActivationCheckRuntimeJitiLoaders.clear();
    cachedFacadeModuleLocationsByKey.clear();
}
export const __testing = {
    loadFacadeModuleAtLocationSync,
    resolveRegistryPluginModuleLocationFromRegistry: resolveRegistryPluginModuleLocationFromRecords,
    resolveFacadeModuleLocation,
    evaluateBundledPluginPublicSurfaceAccess: ((...args) => loadFacadeActivationCheckRuntime().evaluateBundledPluginPublicSurfaceAccess(...args)),
    throwForBundledPluginPublicSurfaceAccess: ((...args) => loadFacadeActivationCheckRuntime().throwForBundledPluginPublicSurfaceAccess(...args)),
    resolveActivatedBundledPluginPublicSurfaceAccessOrThrow: ((params) => loadFacadeActivationCheckRuntime().resolveActivatedBundledPluginPublicSurfaceAccessOrThrow(buildFacadeActivationCheckParams(params))),
    resolveBundledPluginPublicSurfaceAccess: ((params) => loadFacadeActivationCheckRuntime().resolveBundledPluginPublicSurfaceAccess(buildFacadeActivationCheckParams(params))),
    resolveTrackedFacadePluginId: ((params) => loadFacadeActivationCheckRuntime().resolveTrackedFacadePluginId(buildFacadeActivationCheckParams(params))),
};
