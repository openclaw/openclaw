export function normalizeDeviceAuthRole(role) {
    return role.trim();
}
export function normalizeDeviceAuthScopes(scopes) {
    if (!Array.isArray(scopes)) {
        return [];
    }
    const out = new Set();
    for (const scope of scopes) {
        const trimmed = scope.trim();
        if (trimmed) {
            out.add(trimmed);
        }
    }
    if (out.has("operator.admin")) {
        out.add("operator.read");
        out.add("operator.write");
    }
    else if (out.has("operator.write")) {
        out.add("operator.read");
    }
    return [...out].toSorted();
}
