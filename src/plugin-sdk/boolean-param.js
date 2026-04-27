import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
/** Read loose boolean params from tool input that may arrive as booleans or "true"/"false" strings. */
export function readBooleanParam(params, key) {
    const raw = params[key];
    if (typeof raw === "boolean") {
        return raw;
    }
    const normalized = normalizeOptionalLowercaseString(raw);
    if (normalized === "true") {
        return true;
    }
    if (normalized === "false") {
        return false;
    }
    return undefined;
}
