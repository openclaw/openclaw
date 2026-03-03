function dedupeAllowlistEntries(entries) {
    const seen = new Set();
    const deduped = [];
    for (const entry of entries) {
        const normalized = entry.trim();
        if (!normalized) {
            continue;
        }
        const key = normalized.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(normalized);
    }
    return deduped;
}
export function mergeAllowlist(params) {
    return dedupeAllowlistEntries([
        ...(params.existing ?? []).map((entry) => String(entry)),
        ...params.additions,
    ]);
}
export function buildAllowlistResolutionSummary(resolvedUsers, opts) {
    const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
    const resolvedOk = (entry) => Boolean(entry.resolved && entry.id);
    const formatResolved = opts?.formatResolved ?? ((entry) => `${entry.input}→${entry.id}`);
    const formatUnresolved = opts?.formatUnresolved ?? ((entry) => entry.input);
    const mapping = resolvedUsers.filter(resolvedOk).map(formatResolved);
    const additions = resolvedUsers
        .filter(resolvedOk)
        .map((entry) => entry.id)
        .filter((entry) => Boolean(entry));
    const unresolved = resolvedUsers.filter((entry) => !resolvedOk(entry)).map(formatUnresolved);
    return { resolvedMap, mapping, unresolved, additions };
}
export function resolveAllowlistIdAdditions(params) {
    const additions = [];
    for (const entry of params.existing) {
        const trimmed = String(entry).trim();
        const resolved = params.resolvedMap.get(trimmed);
        if (resolved?.resolved && resolved.id) {
            additions.push(resolved.id);
        }
    }
    return additions;
}
export function canonicalizeAllowlistWithResolvedIds(params) {
    const canonicalized = [];
    for (const entry of params.existing ?? []) {
        const trimmed = String(entry).trim();
        if (!trimmed) {
            continue;
        }
        if (trimmed === "*") {
            canonicalized.push(trimmed);
            continue;
        }
        const resolved = params.resolvedMap.get(trimmed);
        canonicalized.push(resolved?.resolved && resolved.id ? resolved.id : trimmed);
    }
    return dedupeAllowlistEntries(canonicalized);
}
export function patchAllowlistUsersInConfigEntries(params) {
    const nextEntries = { ...params.entries };
    for (const [entryKey, entryConfig] of Object.entries(params.entries)) {
        if (!entryConfig || typeof entryConfig !== "object") {
            continue;
        }
        const users = entryConfig.users;
        if (!Array.isArray(users) || users.length === 0) {
            continue;
        }
        const resolvedUsers = params.strategy === "canonicalize"
            ? canonicalizeAllowlistWithResolvedIds({
                existing: users,
                resolvedMap: params.resolvedMap,
            })
            : mergeAllowlist({
                existing: users,
                additions: resolveAllowlistIdAdditions({
                    existing: users,
                    resolvedMap: params.resolvedMap,
                }),
            });
        nextEntries[entryKey] = {
            ...entryConfig,
            users: resolvedUsers,
        };
    }
    return nextEntries;
}
export function addAllowlistUserEntriesFromConfigEntry(target, entry) {
    if (!entry || typeof entry !== "object") {
        return;
    }
    const users = entry.users;
    if (!Array.isArray(users)) {
        return;
    }
    for (const value of users) {
        const trimmed = String(value).trim();
        if (trimmed && trimmed !== "*") {
            target.add(trimmed);
        }
    }
}
export function summarizeMapping(label, mapping, unresolved, runtime) {
    const lines = [];
    if (mapping.length > 0) {
        const sample = mapping.slice(0, 6);
        const suffix = mapping.length > sample.length ? ` (+${mapping.length - sample.length})` : "";
        lines.push(`${label} resolved: ${sample.join(", ")}${suffix}`);
    }
    if (unresolved.length > 0) {
        const sample = unresolved.slice(0, 6);
        const suffix = unresolved.length > sample.length ? ` (+${unresolved.length - sample.length})` : "";
        lines.push(`${label} unresolved: ${sample.join(", ")}${suffix}`);
    }
    if (lines.length > 0) {
        runtime.log?.(lines.join("\n"));
    }
}
