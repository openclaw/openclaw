import { normalizeStringEntries } from "../../../shared/string-normalization.js";
export function hasAllowFromEntries(list) {
    return Array.isArray(list) && normalizeStringEntries(list).length > 0;
}
