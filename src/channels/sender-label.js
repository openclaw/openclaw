function normalize(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function normalizeSenderLabelParams(params) {
    return {
        name: normalize(params.name),
        username: normalize(params.username),
        tag: normalize(params.tag),
        e164: normalize(params.e164),
        id: normalize(params.id),
    };
}
export function resolveSenderLabel(params) {
    const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);
    const display = name ?? username ?? tag ?? "";
    const idPart = e164 ?? id ?? "";
    if (display && idPart && display !== idPart) {
        return `${display} (${idPart})`;
    }
    return display || idPart || null;
}
export function listSenderLabelCandidates(params) {
    const candidates = new Set();
    const { name, username, tag, e164, id } = normalizeSenderLabelParams(params);
    if (name) {
        candidates.add(name);
    }
    if (username) {
        candidates.add(username);
    }
    if (tag) {
        candidates.add(tag);
    }
    if (e164) {
        candidates.add(e164);
    }
    if (id) {
        candidates.add(id);
    }
    const resolved = resolveSenderLabel(params);
    if (resolved) {
        candidates.add(resolved);
    }
    return Array.from(candidates);
}
