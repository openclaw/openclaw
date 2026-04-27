import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeAnyChannelId } from "../registry.js";
import { getBundledChannelPlugin } from "./bundled.js";
import { getLoadedChannelPluginById, listLoadedChannelPlugins } from "./registry-loaded.js";
export function listChannelPlugins() {
    return listLoadedChannelPlugins();
}
export function getLoadedChannelPlugin(id) {
    const resolvedId = normalizeOptionalString(id) ?? "";
    if (!resolvedId) {
        return undefined;
    }
    return getLoadedChannelPluginById(resolvedId);
}
export function getChannelPlugin(id) {
    const resolvedId = normalizeOptionalString(id) ?? "";
    if (!resolvedId) {
        return undefined;
    }
    return getLoadedChannelPlugin(resolvedId) ?? getBundledChannelPlugin(resolvedId);
}
export function normalizeChannelId(raw) {
    return normalizeAnyChannelId(raw);
}
