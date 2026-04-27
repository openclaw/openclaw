import { listChannelCatalogEntries } from "../../plugins/channel-catalog-registry.js";
import { resolveBundledChannelRootScope } from "./bundled-root.js";
const bundledChannelPluginIdsByRoot = new Map();
export function listBundledChannelPluginIdsForRoot(packageRoot, env = process.env) {
    const cached = bundledChannelPluginIdsByRoot.get(packageRoot);
    if (cached) {
        return [...cached];
    }
    const loaded = listChannelCatalogEntries({ origin: "bundled", env })
        .map((entry) => entry.pluginId)
        .toSorted((left, right) => left.localeCompare(right));
    bundledChannelPluginIdsByRoot.set(packageRoot, loaded);
    return [...loaded];
}
export function listBundledChannelPluginIds() {
    return listBundledChannelPluginIdsForRoot(resolveBundledChannelRootScope().cacheKey);
}
