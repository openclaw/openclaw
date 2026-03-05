export type AllowlistMatchSource =
  | "wildcard"
  | "id"
  | "name"
  | "tag"
  | "username"
  | "prefixed-id"
  | "prefixed-user"
  | "prefixed-name"
  | "slug"
  | "localpart";

export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;
};

type CachedAllowListSet = {
  size: number;
  signature: string;
  set: Set<string>;
};

type CachedSimpleAllowFrom = {
  normalized: string[];
  size: number;
  signature: string;
  wildcard: boolean;
  set: Set<string>;
};

const ALLOWLIST_SET_CACHE = new WeakMap<string[], CachedAllowListSet>();
const SIMPLE_ALLOWLIST_CACHE = new WeakMap<Array<string | number>, CachedSimpleAllowFrom>();

export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

export function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: string[];
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  const allowSet = resolveAllowListSet(params.allowList);
  for (const candidate of params.candidates) {
    if (!candidate.value) {
      continue;
    }
    if (allowSet.has(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function resolveAllowlistMatchSimple(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = resolveSimpleAllowFrom(params.allowFrom);

  if (allowFrom.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = params.senderId.toLowerCase();
  if (allowFrom.set.has(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }

  const senderName = params.senderName?.toLowerCase();
  if (params.allowNameMatching === true && senderName && allowFrom.set.has(senderName)) {
    return { allowed: true, matchKey: senderName, matchSource: "name" };
  }

  return { allowed: false };
}

function buildArrayCacheSignature(values: ReadonlyArray<string | number>): string {
  let signature = `${values.length}:`;
  for (const value of values) {
    const normalized = String(value);
    signature += `${normalized.length}:${normalized};`;
  }
  return signature;
}

function resolveAllowListSet(allowList: string[]): Set<string> {
  const signature = buildArrayCacheSignature(allowList);
  const cached = ALLOWLIST_SET_CACHE.get(allowList);
  if (cached && cached.size === allowList.length && cached.signature === signature) {
    return cached.set;
  }
  const set = new Set(allowList);
  ALLOWLIST_SET_CACHE.set(allowList, { size: allowList.length, signature, set });
  return set;
}

function resolveSimpleAllowFrom(allowFrom: Array<string | number>): CachedSimpleAllowFrom {
  const signature = buildArrayCacheSignature(allowFrom);
  const cached = SIMPLE_ALLOWLIST_CACHE.get(allowFrom);
  if (cached && cached.size === allowFrom.length && cached.signature === signature) {
    return cached;
  }

  const normalized = allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  const set = new Set(normalized);
  const built: CachedSimpleAllowFrom = {
    normalized,
    size: allowFrom.length,
    signature,
    wildcard: set.has("*"),
    set,
  };
  SIMPLE_ALLOWLIST_CACHE.set(allowFrom, built);
  return built;
}
