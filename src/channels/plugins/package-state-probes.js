import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listChannelCatalogEntries, } from "../../plugins/channel-catalog-registry.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { isJavaScriptModulePath, loadChannelPluginModule, resolveExistingPluginModulePath, } from "./module-loader.js";
const log = createSubsystemLogger("channels");
const registryCache = new Map();
function resolveChannelPackageStateMetadata(entry, metadataKey) {
    const metadata = entry.channel[metadataKey];
    if (!metadata || typeof metadata !== "object") {
        return null;
    }
    const specifier = normalizeOptionalString(metadata.specifier) ?? "";
    const exportName = normalizeOptionalString(metadata.exportName) ?? "";
    if (!specifier || !exportName) {
        return null;
    }
    return { specifier, exportName };
}
function getChannelPackageStateRegistry(metadataKey) {
    const cached = registryCache.get(metadataKey);
    if (cached) {
        return cached;
    }
    const catalog = listChannelCatalogEntries({ origin: "bundled" }).filter((entry) => Boolean(resolveChannelPackageStateMetadata(entry, metadataKey)));
    const registry = {
        catalog,
        entriesById: new Map(catalog.map((entry) => [entry.pluginId, entry])),
        checkerCache: new Map(),
    };
    registryCache.set(metadataKey, registry);
    return registry;
}
function resolveChannelPackageStateChecker(params) {
    const registry = getChannelPackageStateRegistry(params.metadataKey);
    const cached = registry.checkerCache.get(params.entry.pluginId);
    if (cached !== undefined) {
        return cached;
    }
    const metadata = resolveChannelPackageStateMetadata(params.entry, params.metadataKey);
    if (!metadata) {
        registry.checkerCache.set(params.entry.pluginId, null);
        return null;
    }
    try {
        const moduleExport = loadChannelPluginModule({
            modulePath: resolveExistingPluginModulePath(params.entry.rootDir, metadata.specifier),
            rootDir: params.entry.rootDir,
            shouldTryNativeRequire: isJavaScriptModulePath,
        });
        const checker = moduleExport[metadata.exportName];
        if (typeof checker !== "function") {
            throw new Error(`missing ${params.metadataKey} export ${metadata.exportName}`);
        }
        registry.checkerCache.set(params.entry.pluginId, checker);
        return checker;
    }
    catch (error) {
        const detail = formatErrorMessage(error);
        log.warn(`[channels] failed to load ${params.metadataKey} checker for ${params.entry.pluginId}: ${detail}`);
        registry.checkerCache.set(params.entry.pluginId, null);
        return null;
    }
}
export function listBundledChannelIdsForPackageState(metadataKey) {
    return getChannelPackageStateRegistry(metadataKey).catalog.map((entry) => entry.pluginId);
}
export function hasBundledChannelPackageState(params) {
    const registry = getChannelPackageStateRegistry(params.metadataKey);
    const entry = registry.entriesById.get(params.channelId);
    if (!entry) {
        return false;
    }
    const checker = resolveChannelPackageStateChecker({
        entry,
        metadataKey: params.metadataKey,
    });
    return checker ? checker({ cfg: params.cfg, env: params.env }) : false;
}
