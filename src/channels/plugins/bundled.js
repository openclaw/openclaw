import path from "node:path";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listBundledChannelPluginMetadata, resolveBundledChannelGeneratedPath, } from "../../plugins/bundled-channel-runtime.js";
import { isBuiltBundledPluginRuntimeRoot, prepareBundledPluginRuntimeRoot, } from "../../plugins/bundled-runtime-root.js";
import { unwrapDefaultModuleExport } from "../../plugins/module-export.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";
import { normalizeChannelMeta } from "./meta-normalization.js";
import { isJavaScriptModulePath, loadChannelPluginModule } from "./module-loader.js";
const log = createSubsystemLogger("channels");
function resolveChannelPluginModuleEntry(moduleExport) {
    const resolved = unwrapDefaultModuleExport(moduleExport);
    if (!resolved || typeof resolved !== "object") {
        return null;
    }
    const record = resolved;
    if (record.kind !== "bundled-channel-entry") {
        return null;
    }
    if (typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.description !== "string" ||
        typeof record.register !== "function" ||
        typeof record.loadChannelPlugin !== "function") {
        return null;
    }
    return record;
}
function resolveChannelSetupModuleEntry(moduleExport) {
    const resolved = unwrapDefaultModuleExport(moduleExport);
    if (!resolved || typeof resolved !== "object") {
        return null;
    }
    const record = resolved;
    if (record.kind !== "bundled-channel-setup-entry") {
        return null;
    }
    if (typeof record.loadSetupPlugin !== "function") {
        return null;
    }
    return record;
}
function hasSetupEntryFeature(entry, feature) {
    return entry?.features?.[feature] === true;
}
function hasChannelEntryFeature(entry, feature) {
    return entry?.features?.[feature] === true;
}
function resolveBundledChannelBoundaryRoot(params) {
    const overrideRoot = params.pluginsDir
        ? path.resolve(params.pluginsDir, params.metadata.dirName)
        : null;
    if (overrideRoot &&
        (params.modulePath === overrideRoot ||
            params.modulePath.startsWith(`${overrideRoot}${path.sep}`))) {
        return overrideRoot;
    }
    const distRoot = path.resolve(params.packageRoot, "dist", "extensions", params.metadata.dirName);
    if (params.modulePath === distRoot || params.modulePath.startsWith(`${distRoot}${path.sep}`)) {
        return distRoot;
    }
    return path.resolve(params.packageRoot, "extensions", params.metadata.dirName);
}
function resolveBundledChannelScanDir(rootScope) {
    return rootScope.pluginsDir;
}
function resolveGeneratedBundledChannelModulePath(params) {
    if (!params.entry) {
        return null;
    }
    return resolveBundledChannelGeneratedPath(params.rootScope.packageRoot, params.entry, params.metadata.dirName, resolveBundledChannelScanDir(params.rootScope));
}
function loadGeneratedBundledChannelModule(params) {
    let modulePath = resolveGeneratedBundledChannelModulePath(params);
    if (!modulePath) {
        throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
    }
    const scanDir = resolveBundledChannelScanDir(params.rootScope);
    let boundaryRoot = resolveBundledChannelBoundaryRoot({
        packageRoot: params.rootScope.packageRoot,
        ...(scanDir ? { pluginsDir: scanDir } : {}),
        metadata: params.metadata,
        modulePath,
    });
    if (params.installRuntimeDeps !== false && isBuiltBundledPluginRuntimeRoot(boundaryRoot)) {
        const prepared = prepareBundledPluginRuntimeRoot({
            pluginId: params.metadata.manifest.id,
            pluginRoot: boundaryRoot,
            modulePath,
            env: process.env,
            logInstalled: (installedSpecs) => {
                log.debug(`[channels] ${params.metadata.manifest.id} installed bundled runtime deps: ${installedSpecs.join(", ")}`);
            },
        });
        modulePath = prepared.modulePath;
        boundaryRoot = prepared.pluginRoot;
    }
    return loadChannelPluginModule({
        modulePath,
        rootDir: boundaryRoot,
        boundaryRootDir: boundaryRoot,
        shouldTryNativeRequire: (safePath) => safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
    });
}
function loadGeneratedBundledChannelEntry(params) {
    try {
        const entry = resolveChannelPluginModuleEntry(loadGeneratedBundledChannelModule({
            rootScope: params.rootScope,
            metadata: params.metadata,
            entry: params.metadata.source,
            installRuntimeDeps: true,
        }));
        if (!entry) {
            log.warn(`[channels] bundled channel entry ${params.metadata.manifest.id} missing bundled-channel-entry contract; skipping`);
            return null;
        }
        return {
            id: params.metadata.manifest.id,
            entry,
        };
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel ${params.metadata.manifest.id}: ${detail}`);
        return null;
    }
}
function loadGeneratedBundledChannelSetupEntry(params) {
    if (!params.metadata.setupSource) {
        return null;
    }
    try {
        const setupEntry = resolveChannelSetupModuleEntry(loadGeneratedBundledChannelModule({
            rootScope: params.rootScope,
            metadata: params.metadata,
            entry: params.metadata.setupSource,
            installRuntimeDeps: false,
        }));
        if (!setupEntry) {
            log.warn(`[channels] bundled channel setup entry ${params.metadata.manifest.id} missing bundled-channel-setup-entry contract; skipping`);
            return null;
        }
        return setupEntry;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel setup entry ${params.metadata.manifest.id}: ${detail}`);
        return null;
    }
}
const cachedBundledChannelMetadata = new Map();
const bundledChannelCacheContexts = new Map();
function createBundledChannelCacheContext() {
    return {
        pluginLoadInProgressIds: new Set(),
        setupPluginLoadInProgressIds: new Set(),
        entryLoadInProgressIds: new Set(),
        setupEntryLoadInProgressIds: new Set(),
        lazyEntriesById: new Map(),
        lazySetupEntriesById: new Map(),
        lazyPluginsById: new Map(),
        lazySetupPluginsById: new Map(),
        lazySecretsById: new Map(),
        lazySetupSecretsById: new Map(),
        lazyAccountInspectorsById: new Map(),
    };
}
function getBundledChannelCacheContext(cacheKey) {
    const cached = bundledChannelCacheContexts.get(cacheKey);
    if (cached) {
        return cached;
    }
    const created = createBundledChannelCacheContext();
    bundledChannelCacheContexts.set(cacheKey, created);
    return created;
}
function resolveActiveBundledChannelCacheScope() {
    const rootScope = resolveBundledChannelRootScope();
    return {
        rootScope,
        cacheContext: getBundledChannelCacheContext(rootScope.cacheKey),
    };
}
function listBundledChannelMetadata(rootScope = resolveBundledChannelRootScope()) {
    const cached = cachedBundledChannelMetadata.get(rootScope.cacheKey);
    if (cached) {
        return cached;
    }
    const scanDir = resolveBundledChannelScanDir(rootScope);
    const loaded = listBundledChannelPluginMetadata({
        rootDir: rootScope.packageRoot,
        ...(scanDir ? { scanDir } : {}),
        includeChannelConfigs: false,
        includeSyntheticChannelConfigs: false,
    }).filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0);
    cachedBundledChannelMetadata.set(rootScope.cacheKey, loaded);
    return loaded;
}
function listBundledChannelPluginIdsForRoot(rootScope) {
    return listBundledChannelMetadata(rootScope)
        .map((metadata) => metadata.manifest.id)
        .toSorted((left, right) => left.localeCompare(right));
}
function shouldIncludeBundledChannelSetupFeatureForConfig(params) {
    if (!params.config) {
        return true;
    }
    const plugins = params.config.plugins;
    if (plugins?.enabled === false) {
        return false;
    }
    const pluginId = params.metadata.manifest.id;
    if (plugins?.deny?.includes(pluginId)) {
        return false;
    }
    if (plugins?.entries?.[pluginId]?.enabled === false) {
        return false;
    }
    let hasExplicitChannelDisable = false;
    for (const channelId of params.metadata.manifest.channels ?? [pluginId]) {
        const normalizedChannelId = normalizeOptionalLowercaseString(channelId);
        if (!normalizedChannelId) {
            continue;
        }
        const channelConfig = params.config.channels?.[normalizedChannelId];
        if (!channelConfig || typeof channelConfig !== "object" || Array.isArray(channelConfig)) {
            continue;
        }
        if (channelConfig.enabled === false) {
            hasExplicitChannelDisable = true;
            continue;
        }
        return true;
    }
    return !hasExplicitChannelDisable;
}
function listBundledChannelPluginIdsForSetupFeature(rootScope, feature, options = {}) {
    const hinted = listBundledChannelMetadata(rootScope)
        .filter((metadata) => metadata.packageManifest?.setupFeatures?.[feature] === true &&
        shouldIncludeBundledChannelSetupFeatureForConfig({
            metadata,
            config: options.config,
        }))
        .map((metadata) => metadata.manifest.id)
        .toSorted((left, right) => left.localeCompare(right));
    return hinted.length > 0
        ? hinted
        : listBundledChannelMetadata(rootScope)
            .filter((metadata) => shouldIncludeBundledChannelSetupFeatureForConfig({
            metadata,
            config: options.config,
        }))
            .map((metadata) => metadata.manifest.id)
            .toSorted((left, right) => left.localeCompare(right));
}
export function listBundledChannelPluginIds() {
    return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope());
}
export function hasBundledChannelPackageSetupFeature(id, feature) {
    const rootScope = resolveBundledChannelRootScope();
    return (resolveBundledChannelMetadata(id, rootScope)?.packageManifest?.setupFeatures?.[feature] === true);
}
function resolveBundledChannelMetadata(id, rootScope) {
    return listBundledChannelMetadata(rootScope).find((metadata) => metadata.manifest.id === id || metadata.manifest.channels?.includes(id));
}
function getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, cacheContext) {
    const cached = cacheContext.lazyEntriesById.get(id);
    if (cached) {
        return cached;
    }
    if (cached === null) {
        return null;
    }
    const metadata = resolveBundledChannelMetadata(id, rootScope);
    if (!metadata) {
        cacheContext.lazyEntriesById.set(id, null);
        return null;
    }
    if (cacheContext.entryLoadInProgressIds.has(id)) {
        return null;
    }
    cacheContext.entryLoadInProgressIds.add(id);
    try {
        const entry = loadGeneratedBundledChannelEntry({
            rootScope,
            metadata,
        });
        cacheContext.lazyEntriesById.set(id, entry);
        if (entry?.entry.id && entry.entry.id !== id) {
            cacheContext.lazyEntriesById.set(entry.entry.id, entry);
        }
        return entry;
    }
    finally {
        cacheContext.entryLoadInProgressIds.delete(id);
    }
}
function cacheBundledChannelSetupEntry(metadata, cacheContext, entry, requestedId) {
    const ids = new Set([
        metadata.manifest.id,
        ...(metadata.manifest.channels ?? []),
        ...(requestedId ? [requestedId] : []),
    ]);
    for (const id of ids) {
        cacheContext.lazySetupEntriesById.set(id, entry);
    }
}
function getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, cacheContext) {
    if (cacheContext.lazySetupEntriesById.has(id)) {
        return cacheContext.lazySetupEntriesById.get(id) ?? null;
    }
    const metadata = resolveBundledChannelMetadata(id, rootScope);
    if (!metadata) {
        cacheContext.lazySetupEntriesById.set(id, null);
        return null;
    }
    if (cacheContext.setupEntryLoadInProgressIds.has(id)) {
        return null;
    }
    cacheContext.setupEntryLoadInProgressIds.add(id);
    try {
        const setupEntry = loadGeneratedBundledChannelSetupEntry({
            rootScope,
            metadata,
        });
        cacheBundledChannelSetupEntry(metadata, cacheContext, setupEntry, id);
        return setupEntry;
    }
    finally {
        cacheContext.setupEntryLoadInProgressIds.delete(id);
    }
}
function getBundledChannelPluginForRoot(id, rootScope, cacheContext) {
    if (cacheContext.lazyPluginsById.has(id)) {
        return cacheContext.lazyPluginsById.get(id) ?? undefined;
    }
    if (cacheContext.pluginLoadInProgressIds.has(id)) {
        return undefined;
    }
    const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, cacheContext)?.entry;
    if (!entry) {
        return undefined;
    }
    cacheContext.pluginLoadInProgressIds.add(id);
    try {
        const metadata = resolveBundledChannelMetadata(id, rootScope);
        const plugin = entry.loadChannelPlugin();
        const normalizedPlugin = {
            ...plugin,
            meta: normalizeChannelMeta({
                id: plugin.id,
                meta: plugin.meta,
                existing: metadata?.packageManifest?.channel,
            }),
        };
        cacheContext.lazyPluginsById.set(id, normalizedPlugin);
        return normalizedPlugin;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel ${id}: ${detail}`);
        cacheContext.lazyPluginsById.set(id, null);
        return undefined;
    }
    finally {
        cacheContext.pluginLoadInProgressIds.delete(id);
    }
}
function getBundledChannelSecretsForRoot(id, rootScope, cacheContext) {
    if (cacheContext.lazySecretsById.has(id)) {
        return cacheContext.lazySecretsById.get(id) ?? undefined;
    }
    const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, cacheContext)?.entry;
    if (!entry) {
        return undefined;
    }
    try {
        const secrets = entry.loadChannelSecrets?.() ??
            getBundledChannelPluginForRoot(id, rootScope, cacheContext)?.secrets;
        cacheContext.lazySecretsById.set(id, secrets ?? null);
        return secrets;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel secrets ${id}: ${detail}`);
        cacheContext.lazySecretsById.set(id, null);
        return undefined;
    }
}
function getBundledChannelAccountInspectorForRoot(id, rootScope, cacheContext) {
    if (cacheContext.lazyAccountInspectorsById.has(id)) {
        return cacheContext.lazyAccountInspectorsById.get(id) ?? undefined;
    }
    const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, cacheContext)?.entry;
    if (!entry?.loadChannelAccountInspector) {
        cacheContext.lazyAccountInspectorsById.set(id, null);
        return undefined;
    }
    try {
        const inspector = entry.loadChannelAccountInspector();
        cacheContext.lazyAccountInspectorsById.set(id, inspector);
        return inspector;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel account inspector ${id}: ${detail}`);
        cacheContext.lazyAccountInspectorsById.set(id, null);
        return undefined;
    }
}
function getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext) {
    if (cacheContext.lazySetupPluginsById.has(id)) {
        return cacheContext.lazySetupPluginsById.get(id) ?? undefined;
    }
    if (cacheContext.setupPluginLoadInProgressIds.has(id)) {
        return undefined;
    }
    const entry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, cacheContext);
    if (!entry) {
        return undefined;
    }
    cacheContext.setupPluginLoadInProgressIds.add(id);
    try {
        const plugin = entry.loadSetupPlugin({ installRuntimeDeps: false });
        cacheContext.lazySetupPluginsById.set(id, plugin);
        return plugin;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel setup ${id}: ${detail}`);
        cacheContext.lazySetupPluginsById.set(id, null);
        return undefined;
    }
    finally {
        cacheContext.setupPluginLoadInProgressIds.delete(id);
    }
}
function getBundledChannelSetupSecretsForRoot(id, rootScope, cacheContext) {
    if (cacheContext.lazySetupSecretsById.has(id)) {
        return cacheContext.lazySetupSecretsById.get(id) ?? undefined;
    }
    const entry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, cacheContext);
    if (!entry) {
        return undefined;
    }
    try {
        const secrets = entry.loadSetupSecrets?.() ??
            getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext)?.secrets;
        cacheContext.lazySetupSecretsById.set(id, secrets ?? null);
        return secrets;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load bundled channel setup secrets ${id}: ${detail}`);
        cacheContext.lazySetupSecretsById.set(id, null);
        return undefined;
    }
}
export function listBundledChannelPlugins() {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
        const plugin = getBundledChannelPluginForRoot(id, rootScope, cacheContext);
        return plugin ? [plugin] : [];
    });
}
export function listBundledChannelSetupPlugins() {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return listBundledChannelPluginIdsForRoot(rootScope).flatMap((id) => {
        const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext);
        return plugin ? [plugin] : [];
    });
}
export function listBundledChannelSetupPluginsByFeature(feature, options = {}) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return listBundledChannelPluginIdsForSetupFeature(rootScope, feature, {
        config: options.config,
    }).flatMap((id) => {
        const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, cacheContext);
        if (!hasSetupEntryFeature(setupEntry, feature)) {
            return [];
        }
        const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext);
        return plugin ? [plugin] : [];
    });
}
export function listBundledChannelLegacySessionSurfaces(options = {}) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return listBundledChannelPluginIdsForSetupFeature(rootScope, "legacySessionSurfaces", {
        config: options.config,
    }).flatMap((id) => {
        const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, cacheContext);
        const surface = setupEntry?.loadLegacySessionSurface?.({ installRuntimeDeps: false });
        if (surface) {
            return [surface];
        }
        if (!hasSetupEntryFeature(setupEntry, "legacySessionSurfaces")) {
            return [];
        }
        const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext);
        return plugin?.messaging ? [plugin.messaging] : [];
    });
}
export function listBundledChannelLegacyStateMigrationDetectors(options = {}) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return listBundledChannelPluginIdsForSetupFeature(rootScope, "legacyStateMigrations", {
        config: options.config,
    }).flatMap((id) => {
        const setupEntry = getLazyGeneratedBundledChannelSetupEntryForRoot(id, rootScope, cacheContext);
        const detector = setupEntry?.loadLegacyStateMigrationDetector?.({ installRuntimeDeps: false });
        if (detector) {
            return [detector];
        }
        if (!hasSetupEntryFeature(setupEntry, "legacyStateMigrations")) {
            return [];
        }
        const plugin = getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext);
        return plugin?.lifecycle?.detectLegacyStateMigrations
            ? [plugin.lifecycle.detectLegacyStateMigrations]
            : [];
    });
}
export function hasBundledChannelEntryFeature(id, feature) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    const entry = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, cacheContext)?.entry;
    return hasChannelEntryFeature(entry, feature);
}
export function getBundledChannelAccountInspector(id) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return getBundledChannelAccountInspectorForRoot(id, rootScope, cacheContext);
}
export function getBundledChannelPlugin(id) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return getBundledChannelPluginForRoot(id, rootScope, cacheContext);
}
export function getBundledChannelSecrets(id) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return getBundledChannelSecretsForRoot(id, rootScope, cacheContext);
}
export function getBundledChannelSetupPlugin(id) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return getBundledChannelSetupPluginForRoot(id, rootScope, cacheContext);
}
export function getBundledChannelSetupSecrets(id) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    return getBundledChannelSetupSecretsForRoot(id, rootScope, cacheContext);
}
export function requireBundledChannelPlugin(id) {
    const plugin = getBundledChannelPlugin(id);
    if (!plugin) {
        throw new Error(`missing bundled channel plugin: ${id}`);
    }
    return plugin;
}
export function setBundledChannelRuntime(id, runtime) {
    const { rootScope, cacheContext } = resolveActiveBundledChannelCacheScope();
    const setter = getLazyGeneratedBundledChannelEntryForRoot(id, rootScope, cacheContext)?.entry
        .setChannelRuntime;
    if (!setter) {
        throw new Error(`missing bundled channel runtime setter: ${id}`);
    }
    setter(runtime);
}
