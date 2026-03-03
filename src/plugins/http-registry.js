import { normalizePluginHttpPath } from "./http-path.js";
import { requireActivePluginRegistry } from "./runtime.js";
export function registerPluginHttpRoute(params) {
    const registry = params.registry ?? requireActivePluginRegistry();
    const routes = registry.httpRoutes ?? [];
    registry.httpRoutes = routes;
    const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
    const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
    if (!normalizedPath) {
        params.log?.(`plugin: webhook path missing${suffix}`);
        return () => { };
    }
    const routeMatch = params.match ?? "exact";
    const existingIndex = routes.findIndex((entry) => entry.path === normalizedPath && entry.match === routeMatch);
    if (existingIndex >= 0) {
        const existing = routes[existingIndex];
        if (!existing) {
            return () => { };
        }
        if (!params.replaceExisting) {
            params.log?.(`plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`);
            return () => { };
        }
        if (existing.pluginId && params.pluginId && existing.pluginId !== params.pluginId) {
            params.log?.(`plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId}`);
            return () => { };
        }
        const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
        params.log?.(`plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`);
        routes.splice(existingIndex, 1);
    }
    const entry = {
        path: normalizedPath,
        handler: params.handler,
        auth: params.auth,
        match: routeMatch,
        pluginId: params.pluginId,
        source: params.source,
    };
    routes.push(entry);
    return () => {
        const index = routes.indexOf(entry);
        if (index >= 0) {
            routes.splice(index, 1);
        }
    };
}
