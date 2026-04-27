import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export function normalizeChatType(raw) {
    const value = normalizeOptionalLowercaseString(raw);
    if (!value) {
        return undefined;
    }
    if (value === "direct" || value === "dm") {
        return "direct";
    }
    if (value === "group") {
        return "group";
    }
    if (value === "channel") {
        return "channel";
    }
    return undefined;
}
