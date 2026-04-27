import { CHAT_CHANNEL_ORDER } from "../../channels/registry.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../../shared/string-coerce.js";
import { normalizeAtHashSlug } from "../../shared/string-normalization.js";
const INTERNAL_ALLOWLIST_CHANNEL = "webchat";
const EXPLICIT_ELEVATED_ALLOW_FIELDS = new Set([
    "id",
    "from",
    "e164",
    "name",
    "username",
    "tag",
]);
const SENDER_PREFIXES = [
    ...CHAT_CHANNEL_ORDER,
    INTERNAL_ALLOWLIST_CHANNEL,
    "user",
    "group",
    "channel",
];
const SENDER_PREFIX_RE = new RegExp(`^(${SENDER_PREFIXES.join("|")}):`, "i");
export function stripSenderPrefix(value) {
    if (!value) {
        return "";
    }
    const trimmed = value.trim();
    return trimmed.replace(SENDER_PREFIX_RE, "");
}
export function parseExplicitElevatedAllowEntry(entry) {
    const separatorIndex = entry.indexOf(":");
    if (separatorIndex <= 0) {
        return null;
    }
    const fieldRaw = normalizeLowercaseStringOrEmpty(entry.slice(0, separatorIndex));
    if (!EXPLICIT_ELEVATED_ALLOW_FIELDS.has(fieldRaw)) {
        return null;
    }
    const value = entry.slice(separatorIndex + 1).trim();
    if (!value) {
        return null;
    }
    return {
        field: fieldRaw,
        value,
    };
}
function slugAllowToken(value) {
    return normalizeAtHashSlug(value);
}
function addTokenVariants(tokens, value) {
    if (!value) {
        return;
    }
    tokens.add(value);
    const normalized = normalizeLowercaseStringOrEmpty(value);
    if (normalized) {
        tokens.add(normalized);
    }
}
export function addFormattedTokens(params) {
    const formatted = params.formatAllowFrom(params.values);
    for (const entry of formatted) {
        addTokenVariants(params.tokens, entry);
    }
}
export function matchesFormattedTokens(params) {
    const probeTokens = new Set();
    const values = params.includeStripped
        ? [params.value, stripSenderPrefix(params.value)].filter(Boolean)
        : [params.value];
    addFormattedTokens({
        formatAllowFrom: params.formatAllowFrom,
        values,
        tokens: probeTokens,
    });
    for (const token of probeTokens) {
        if (params.tokens.has(token)) {
            return true;
        }
    }
    return false;
}
export function buildMutableTokens(value) {
    const tokens = new Set();
    const trimmed = normalizeOptionalString(value);
    if (!trimmed) {
        return tokens;
    }
    addTokenVariants(tokens, trimmed);
    const slugged = slugAllowToken(trimmed);
    if (slugged) {
        addTokenVariants(tokens, slugged);
    }
    return tokens;
}
export function matchesMutableTokens(value, tokens) {
    if (!value || tokens.size === 0) {
        return false;
    }
    const probes = new Set();
    addTokenVariants(probes, value);
    const slugged = slugAllowToken(value);
    if (slugged) {
        addTokenVariants(probes, slugged);
    }
    for (const probe of probes) {
        if (tokens.has(probe)) {
            return true;
        }
    }
    return false;
}
