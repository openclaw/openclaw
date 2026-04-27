import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
export const DEFAULT_ACCOUNT_ID = "default";
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const ACCOUNT_ID_CACHE_MAX = 512;
const normalizeAccountIdCache = new Map();
const normalizeOptionalAccountIdCache = new Map();
function canonicalizeAccountId(value) {
    const normalized = normalizeLowercaseStringOrEmpty(value);
    if (VALID_ID_RE.test(value)) {
        return normalized;
    }
    return normalized
        .replace(INVALID_CHARS_RE, "-")
        .replace(LEADING_DASH_RE, "")
        .replace(TRAILING_DASH_RE, "")
        .slice(0, 64);
}
function normalizeCanonicalAccountId(value) {
    const canonical = canonicalizeAccountId(value);
    if (!canonical || isBlockedObjectKey(canonical)) {
        return undefined;
    }
    return canonical;
}
export function normalizeAccountId(value) {
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
        return DEFAULT_ACCOUNT_ID;
    }
    const cached = normalizeAccountIdCache.get(trimmed);
    if (cached) {
        return cached;
    }
    const normalized = normalizeCanonicalAccountId(trimmed) || DEFAULT_ACCOUNT_ID;
    setNormalizeCache(normalizeAccountIdCache, trimmed, normalized);
    return normalized;
}
export function normalizeOptionalAccountId(value) {
    const trimmed = (value ?? "").trim();
    if (!trimmed) {
        return undefined;
    }
    if (normalizeOptionalAccountIdCache.has(trimmed)) {
        return normalizeOptionalAccountIdCache.get(trimmed);
    }
    const normalized = normalizeCanonicalAccountId(trimmed) || undefined;
    setNormalizeCache(normalizeOptionalAccountIdCache, trimmed, normalized);
    return normalized;
}
function setNormalizeCache(cache, key, value) {
    cache.set(key, value);
    if (cache.size <= ACCOUNT_ID_CACHE_MAX) {
        return;
    }
    const oldest = cache.keys().next();
    if (!oldest.done) {
        cache.delete(oldest.value);
    }
}
