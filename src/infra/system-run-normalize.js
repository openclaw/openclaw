import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeOptionalString } from "../shared/string-coerce.js";
export function normalizeNonEmptyString(value) {
    return typeof value === "string" ? (normalizeOptionalString(value) ?? null) : null;
}
export function normalizeStringArray(value) {
    return Array.isArray(value) ? mapAllowFromEntries(value) : [];
}
