export function resolveNodeRequireFromMeta(metaUrl) {
    const getBuiltinModule = process.getBuiltinModule;
    if (typeof getBuiltinModule !== "function") {
        return null;
    }
    try {
        const moduleNamespace = getBuiltinModule("module");
        const createRequire = typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
        return createRequire ? createRequire(metaUrl) : null;
    }
    catch {
        return null;
    }
}
