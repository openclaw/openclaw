import { canonicalizePathVariant } from "../gateway/security-path.js";
function prefixMatchPath(pathname, prefix) {
    return (pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`));
}
export function doPluginHttpRoutesOverlap(a, b) {
    const aPath = canonicalizePathVariant(a.path);
    const bPath = canonicalizePathVariant(b.path);
    if (a.match === "exact" && b.match === "exact") {
        return aPath === bPath;
    }
    if (a.match === "prefix" && b.match === "prefix") {
        return prefixMatchPath(aPath, bPath) || prefixMatchPath(bPath, aPath);
    }
    const prefixRoute = a.match === "prefix" ? a : b;
    const exactRoute = a.match === "exact" ? a : b;
    return prefixMatchPath(canonicalizePathVariant(exactRoute.path), canonicalizePathVariant(prefixRoute.path));
}
export function findOverlappingPluginHttpRoute(routes, candidate) {
    return routes.find((route) => doPluginHttpRoutesOverlap(route, candidate));
}
