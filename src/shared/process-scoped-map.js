export function resolveProcessScopedMap(key) {
    const proc = process;
    const existing = proc[key];
    if (existing) {
        return existing;
    }
    const created = new Map();
    proc[key] = created;
    return created;
}
