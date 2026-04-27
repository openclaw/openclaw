export function unwrapDefaultModuleExport(moduleExport) {
    let resolved = moduleExport;
    const seen = new Set();
    while (resolved &&
        typeof resolved === "object" &&
        "default" in resolved &&
        !seen.has(resolved)) {
        seen.add(resolved);
        resolved = resolved.default;
    }
    return resolved;
}
