import { normalizeStringEntries } from "../shared/string-normalization.js";
export function mergeDmAllowFromSources(params) {
    const storeEntries = params.dmPolicy === "allowlist" ? [] : (params.storeAllowFrom ?? []);
    return normalizeStringEntries([...(params.allowFrom ?? []), ...storeEntries]);
}
export function resolveGroupAllowFromSources(params) {
    const explicitGroupAllowFrom = Array.isArray(params.groupAllowFrom) && params.groupAllowFrom.length > 0
        ? params.groupAllowFrom
        : undefined;
    const scoped = explicitGroupAllowFrom
        ? explicitGroupAllowFrom
        : params.fallbackToAllowFrom === false
            ? []
            : (params.allowFrom ?? []);
    return normalizeStringEntries(scoped);
}
export function firstDefined(...values) {
    for (const value of values) {
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
}
export function isSenderIdAllowed(allow, senderId, allowWhenEmpty) {
    if (!allow.hasEntries) {
        return allowWhenEmpty;
    }
    if (allow.hasWildcard) {
        return true;
    }
    if (!senderId) {
        return false;
    }
    return allow.entries.includes(senderId);
}
