export function normalizePluginIdScope(ids) {
    if (ids === undefined) {
        return undefined;
    }
    return Array.from(new Set(ids
        .filter((id) => typeof id === "string")
        .map((id) => id.trim())
        .filter(Boolean))).toSorted();
}
export function hasExplicitPluginIdScope(ids) {
    return ids !== undefined;
}
export function hasNonEmptyPluginIdScope(ids) {
    return ids !== undefined && ids.length > 0;
}
export function createPluginIdScopeSet(ids) {
    if (ids === undefined) {
        return null;
    }
    return new Set(ids);
}
export function serializePluginIdScope(ids) {
    return ids === undefined ? "__unscoped__" : JSON.stringify(ids);
}
