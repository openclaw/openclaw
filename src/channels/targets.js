export function normalizeTargetId(kind, id) {
    return `${kind}:${id}`.toLowerCase();
}
export function buildMessagingTarget(kind, id, raw) {
    return {
        kind,
        id,
        raw,
        normalized: normalizeTargetId(kind, id),
    };
}
export function ensureTargetId(params) {
    if (!params.pattern.test(params.candidate)) {
        throw new Error(params.errorMessage);
    }
    return params.candidate;
}
export function parseTargetMention(params) {
    const match = params.raw.match(params.mentionPattern);
    if (!match?.[1]) {
        return undefined;
    }
    return buildMessagingTarget(params.kind, match[1], params.raw);
}
export function parseTargetPrefix(params) {
    if (!params.raw.startsWith(params.prefix)) {
        return undefined;
    }
    const id = params.raw.slice(params.prefix.length).trim();
    return id ? buildMessagingTarget(params.kind, id, params.raw) : undefined;
}
export function parseTargetPrefixes(params) {
    for (const entry of params.prefixes) {
        const parsed = parseTargetPrefix({
            raw: params.raw,
            prefix: entry.prefix,
            kind: entry.kind,
        });
        if (parsed) {
            return parsed;
        }
    }
    return undefined;
}
export function requireTargetKind(params) {
    const kindLabel = params.kind;
    if (!params.target) {
        throw new Error(`${params.platform} ${kindLabel} id is required.`);
    }
    if (params.target.kind !== params.kind) {
        throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
    }
    return params.target.id;
}
