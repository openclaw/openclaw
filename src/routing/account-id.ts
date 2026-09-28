// Routing account id helpers normalize account identifiers for route matching.
import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

export const DEFAULT_ACCOUNT_ID = "default";

// Account ids are config/session keys, not display names. Normalize them into
// short lowercase safe keys and reject prototype-like object keys.
const ACCOUNT_ID_CACHE_MAX = 512;

const normalizedAccountIdCache = new Map<string, string | undefined>();

function normalizeCanonicalAccountId(value: string): string | undefined {
  const canonical = normalizeAgentIdStrict(value);
  return canonical.ok && !isBlockedObjectKey(canonical.value) ? canonical.value : undefined;
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
  return normalizeOptionalAccountId(value) ?? DEFAULT_ACCOUNT_ID;
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
