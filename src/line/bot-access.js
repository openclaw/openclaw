import { firstDefined, isSenderIdAllowed, mergeDmAllowFromSources, } from "../channels/allow-from.js";
function normalizeAllowEntry(value) {
    const trimmed = String(value).trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed === "*") {
        return "*";
    }
    return trimmed.replace(/^line:(?:user:)?/i, "");
}
export const normalizeAllowFrom = (list) => {
    const entries = (list ?? []).map((value) => normalizeAllowEntry(value)).filter(Boolean);
    const hasWildcard = entries.includes("*");
    return {
        entries,
        hasWildcard,
        hasEntries: entries.length > 0,
    };
};
export const normalizeDmAllowFromWithStore = (params) => normalizeAllowFrom(mergeDmAllowFromSources(params));
export const isSenderAllowed = (params) => {
    const { allow, senderId } = params;
    return isSenderIdAllowed(allow, senderId, false);
};
export { firstDefined };
