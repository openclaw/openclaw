import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

export const DEFAULT_ACCOUNT_ID = "default";

// Account ids are config/session keys, not display names. Normalize them into
// short lowercase safe keys and reject prototype-like object keys.
const ACCOUNT_ID_CACHE_MAX = 512;

const normalizedAccountIdCache = new Map<string, string | undefined>();

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
  if (normalizedAccountIdCache.has(trimmed)) {
    return normalizedAccountIdCache.get(trimmed);
  }
  const canonical = normalizeAgentIdStrict(trimmed);
  const normalized =
    canonical.ok && !isBlockedObjectKey(canonical.value) ? canonical.value : undefined;
  normalizedAccountIdCache.set(trimmed, normalized);
  pruneMapToMaxSize(normalizedAccountIdCache, ACCOUNT_ID_CACHE_MAX);
  return normalized;
}
