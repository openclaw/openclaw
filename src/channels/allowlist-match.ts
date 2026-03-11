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

function resolveAllowListSet(allowList: string[]): Set<string> {
  return new Set(allowList);
}

function resolveSimpleAllowFrom(allowFrom: Array<string | number>): {
  normalized: string[];
  size: number;
  wildcard: boolean;
  set: Set<string>;
} {
  const normalized = allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  const set = new Set(normalized);
  return {
    normalized,
    size: allowFrom.length,
    wildcard: set.has("*"),
    set,
  };
}
