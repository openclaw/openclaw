import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeCommandBody } from "../commands-registry.js";
const BTW_COMMAND_RE = /^\/btw(?::|\s|$)/i;
export function isBtwRequestText(text, options) {
    if (!text) {
        return false;
    }
    const normalized = normalizeCommandBody(text, options).trim();
    return BTW_COMMAND_RE.test(normalized);
}
export function extractBtwQuestion(text, options) {
    if (!text) {
        return null;
    }
    const normalized = normalizeCommandBody(text, options).trim();
    const match = normalized.match(/^\/btw(?:\s+(.*))?$/i);
    if (!match) {
        return null;
    }
    return normalizeOptionalString(match[1]) ?? "";
}
