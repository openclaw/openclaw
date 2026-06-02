import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";

/** Candidate class that matched an allowlist entry. */
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

/** Allowlist decision plus optional match metadata for diagnostics. */
export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
  /** Whether the candidate was allowed. */
  allowed: boolean;
  /** Config entry or wildcard that matched. */
  matchKey?: string;
  /** Candidate source that matched the config entry. */
  matchSource?: TSource;
};

/** Precompiled allowlist for repeated candidate checks. */
export type CompiledAllowlist = {
  /** Normalized allowlist entries. */
  set: ReadonlySet<string>;
  /** Whether the wildcard entry allows every candidate. */
  wildcard: boolean;
};

/** Formats match metadata for compact logs and tests. */
export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

/** Compiles already-normalized allowlist entries into a lookup set. */
export function compileAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist {
  const set = new Set(entries.filter(Boolean));
  return {
    set,
    wildcard: set.has("*"),
  };
}

function compileSimpleAllowlist(entries: ReadonlyArray<string | number>): CompiledAllowlist {
  return compileAllowlist(
    entries
      .map((entry) => normalizeOptionalLowercaseString(String(entry)))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

/** Checks candidates in order, returning the first exact allowlist match. */
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

/** Resolves an allowlist decision with wildcard taking precedence over candidate checks. */
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

/** Compiles an allowlist and resolves it against ordered candidate values. */
export function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: ReadonlyArray<string>;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compileAllowlist(params.allowList),
    candidates: params.candidates,
  });
}

/** Resolves the common id/name allowlist shape used by channel sender checks. */
export function resolveAllowlistMatchSimple(params: {
  allowFrom: ReadonlyArray<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  // Compile from the current array contents so in-place config edits are visible immediately.
  const allowFrom = compileSimpleAllowlist(params.allowFrom);

  if (allowFrom.set.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = normalizeLowercaseStringOrEmpty(params.senderId);
  const senderName = normalizeOptionalLowercaseString(params.senderName);
  return resolveAllowlistCandidates({
    compiledAllowlist: allowFrom,
    candidates: [
      { value: senderId, source: "id" },
      // Name matching is opt-in because display names can be mutable or ambiguous.
      ...(params.allowNameMatching === true && senderName
        ? ([{ value: senderName, source: "name" as const }] satisfies Array<{
            value?: string;
            source: "id" | "name";
          }>)
        : []),
    ],
  });
}
