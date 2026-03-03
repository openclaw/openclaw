export function formatAllowlistMatchMeta(match) {
    return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}
export function resolveAllowlistMatchByCandidates(params) {
    for (const candidate of params.candidates) {
        if (!candidate.value) {
            continue;
        }
        if (params.allowList.includes(candidate.value)) {
            return {
                allowed: true,
                matchKey: candidate.value,
                matchSource: candidate.source,
            };
        }
    }
    return { allowed: false };
}
export function resolveAllowlistMatchSimple(params) {
    const allowFrom = params.allowFrom
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean);
    if (allowFrom.length === 0) {
        return { allowed: false };
    }
    if (allowFrom.includes("*")) {
        return { allowed: true, matchKey: "*", matchSource: "wildcard" };
    }
    const senderId = params.senderId.toLowerCase();
    if (allowFrom.includes(senderId)) {
        return { allowed: true, matchKey: senderId, matchSource: "id" };
    }
    const senderName = params.senderName?.toLowerCase();
    if (params.allowNameMatching === true && senderName && allowFrom.includes(senderName)) {
        return { allowed: true, matchKey: senderName, matchSource: "name" };
    }
    return { allowed: false };
}
