export type AllowlistMatchSource =
  | "wildcard"
  | "domain"
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
  set: Set<string>;
};

const ALLOWLIST_SET_CACHE = new WeakMap<string[], CachedAllowListSet>();
const SIMPLE_ALLOWLIST_CACHE = new WeakMap<
  Array<string | number>,
  { normalized: string[]; size: number; wildcard: boolean; set: Set<string> }
>();

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
  senderEmail?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "domain" | "id" | "name"> {
  const allowFrom = resolveSimpleAllowFrom(params.allowFrom);

  if (allowFrom.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  // Domain pattern: "@example.com" matches any email ending with that domain.
  const normalizedEmail = params.senderEmail?.trim().toLowerCase() ?? "";
  if (normalizedEmail) {
    const domainEntry = allowFrom.normalized.find(
      (d) => d.startsWith("@") && normalizedEmail.endsWith(d),
    );
    if (domainEntry) {
      return { allowed: true, matchKey: domainEntry, matchSource: "domain" };
    }
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

function resolveAllowListSet(allowList: string[]): Set<string> {
  const cached = ALLOWLIST_SET_CACHE.get(allowList);
  if (cached && cached.size === allowList.length) {
    return cached.set;
  }
  const set = new Set(allowList);
  ALLOWLIST_SET_CACHE.set(allowList, { size: allowList.length, set });
  return set;
}

function resolveSimpleAllowFrom(allowFrom: Array<string | number>): {
  normalized: string[];
  size: number;
  wildcard: boolean;
  set: Set<string>;
} {
  const cached = SIMPLE_ALLOWLIST_CACHE.get(allowFrom);
  if (cached && cached.size === allowFrom.length) {
    return cached;
  }

  const normalized = allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  const set = new Set(normalized);
  const built = {
    normalized,
    size: allowFrom.length,
    wildcard: set.has("*"),
    set,
  };
  SIMPLE_ALLOWLIST_CACHE.set(allowFrom, built);
  return built;
}
