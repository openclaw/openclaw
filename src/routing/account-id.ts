// Routing account id helpers normalize account identifiers for route matching.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

export const DEFAULT_ACCOUNT_ID = "default";

// Account ids are config/session keys, not display names. Normalize them into
// short lowercase safe keys and reject prototype-like object keys.
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
// Only leading dashes are decoration. Leading underscores must be preserved:
// underscore-prefixed account ids (e.g. accounts._prod) are shipped identities
// that keep resolving to their own credentials, policies, and session keys.
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;
const ACCOUNT_ID_CACHE_MAX = 512;

const normalizedAccountIdCache = new Map<string, string | undefined>();

function canonicalizeAccountId(value: string): string {
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

function normalizeCanonicalAccountId(value: string): string | undefined {
  const canonical = canonicalizeAccountId(value);
  // Check the authored input (lowercased) as well as the canonical form so a
  // prototype-like key is rejected regardless of canonicalization.
  // isBlockedObjectKey is a case-sensitive exact match, so mixed-case __PROTO__
  // must be lowercased first; the canonical form is already lowercased.
  if (
    !canonical ||
    isBlockedObjectKey(normalizeLowercaseStringOrEmpty(value)) ||
    isBlockedObjectKey(canonical)
  ) {
    return undefined;
  }
  return canonical;
}

function resolveCachedCanonicalAccountId(value: string): string | undefined {
  if (normalizedAccountIdCache.has(value)) {
    return normalizedAccountIdCache.get(value);
  }
  const normalized = normalizeCanonicalAccountId(value);
  normalizedAccountIdCache.set(value, normalized);
  // Bounded FIFO-ish cache avoids unbounded growth from user/channel input
  // while keeping hot account ids cheap during routing.
  pruneMapToMaxSize(normalizedAccountIdCache, ACCOUNT_ID_CACHE_MAX);
  return normalized;
}

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_ACCOUNT_ID;
  }
  return resolveCachedCanonicalAccountId(trimmed) ?? DEFAULT_ACCOUNT_ID;
}

// Optional variant for config fields where absence is meaningful. Invalid ids
// return undefined instead of silently selecting the default account.
export function normalizeOptionalAccountId(value: string | undefined | null): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveCachedCanonicalAccountId(trimmed);
}
