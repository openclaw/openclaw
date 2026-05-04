import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

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

export type CompiledAllowlist = {
  set: ReadonlySet<string>;
  wildcard: boolean;
};

export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

export function compileAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist {
  const set = new Set<string>();
  for (const entry of entries) {
    if (entry) {
      set.add(entry);
    }
  }
  return {
    set,
    wildcard: set.has("*"),
  };
}

function compileSimpleAllowlist(entries: ReadonlyArray<string | number>): CompiledAllowlist {
  const set = new Set<string>();
  for (const entry of entries) {
    const normalized = normalizeOptionalLowercaseString(String(entry));
    if (normalized) {
      set.add(normalized);
    }
  }
  return {
    set,
    wildcard: set.has("*"),
  };
}

export function resolveAllowlistCandidates<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  for (const candidate of params.candidates) {
    if (!candidate.value) {
      continue;
    }
    if (params.compiledAllowlist.set.has(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

export function resolveCompiledAllowlistMatch<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  if (params.compiledAllowlist.set.size === 0) {
    return { allowed: false };
  }
  if (params.compiledAllowlist.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" as TSource };
  }
  return resolveAllowlistCandidates(params);
}

export function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: ReadonlyArray<string>;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compileAllowlist(params.allowList),
    candidates: params.candidates,
  });
}

export function resolveAllowlistMatchSimple(params: {
  allowFrom: ReadonlyArray<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = compileSimpleAllowlist(params.allowFrom);

  if (allowFrom.set.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = normalizeLowercaseStringOrEmpty(params.senderId);
  const senderName = normalizeOptionalLowercaseString(params.senderName);
  if (senderId && allowFrom.set.has(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  if (params.allowNameMatching === true && senderName && allowFrom.set.has(senderName)) {
    return { allowed: true, matchKey: senderName, matchSource: "name" };
  }
  return { allowed: false };
}
