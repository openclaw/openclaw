import { resolveAllowlistMatchByCandidates, } from "../../channels/allowlist-match.js";
import { normalizeHyphenSlug, normalizeStringEntries, normalizeStringEntriesLower, } from "../../shared/string-normalization.js";
export function normalizeSlackSlug(raw) {
    return normalizeHyphenSlug(raw);
}
export function normalizeAllowList(list) {
    return normalizeStringEntries(list);
}
export function normalizeAllowListLower(list) {
    return normalizeStringEntriesLower(list);
}
export function resolveSlackAllowListMatch(params) {
    const allowList = params.allowList;
    if (allowList.length === 0) {
        return { allowed: false };
    }
    if (allowList.includes("*")) {
        return { allowed: true, matchKey: "*", matchSource: "wildcard" };
    }
    const id = params.id?.toLowerCase();
    const name = params.name?.toLowerCase();
    const slug = normalizeSlackSlug(name);
    const candidates = [
        { value: id, source: "id" },
        { value: id ? `slack:${id}` : undefined, source: "prefixed-id" },
        { value: id ? `user:${id}` : undefined, source: "prefixed-user" },
        ...(params.allowNameMatching === true
            ? [
                { value: name, source: "name" },
                { value: name ? `slack:${name}` : undefined, source: "prefixed-name" },
                { value: slug, source: "slug" },
            ]
            : []),
    ];
    return resolveAllowlistMatchByCandidates({ allowList, candidates });
}
export function allowListMatches(params) {
    return resolveSlackAllowListMatch(params).allowed;
}
export function resolveSlackUserAllowed(params) {
    const allowList = normalizeAllowListLower(params.allowList);
    if (allowList.length === 0) {
        return true;
    }
    return allowListMatches({
        allowList,
        id: params.userId,
        name: params.userName,
        allowNameMatching: params.allowNameMatching,
    });
}
