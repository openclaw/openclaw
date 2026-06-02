import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/** Source of the config entry selected for a channel target. */
export type ChannelMatchSource = "direct" | "parent" | "wildcard";

/** Match result retaining direct, parent, and wildcard candidates for diagnostics. */
export type ChannelEntryMatch<T> = {
  /** Entry selected for the effective config result. */
  entry?: T;
  /** Config key for the selected entry. */
  key?: string;
  /** Wildcard fallback entry, retained even when a direct match wins. */
  wildcardEntry?: T;
  /** Config key for the wildcard fallback entry. */
  wildcardKey?: string;
  /** Parent conversation entry, retained when direct target matching falls back. */
  parentEntry?: T;
  /** Config key for the parent conversation entry. */
  parentKey?: string;
  /** Key that should be reported to callers as the effective match. */
  matchKey?: string;
  /** Precedence source that produced the effective match. */
  matchSource?: ChannelMatchSource;
};

/** Copies match metadata onto a resolved config result. */
export function applyChannelMatchMeta<
  TResult extends { matchKey?: string; matchSource?: ChannelMatchSource },
>(result: TResult, match: ChannelEntryMatch<unknown>): TResult {
  if (match.matchKey && match.matchSource) {
    result.matchKey = match.matchKey;
    result.matchSource = match.matchSource;
  }
  return result;
}

/** Resolves the matched entry into a config result while preserving match metadata. */
export function resolveChannelMatchConfig<
  TEntry,
  TResult extends { matchKey?: string; matchSource?: ChannelMatchSource },
>(match: ChannelEntryMatch<TEntry>, resolveEntry: (entry: TEntry) => TResult): TResult | null {
  if (!match.entry) {
    return null;
  }
  return applyChannelMatchMeta(resolveEntry(match.entry), match);
}

/** Normalizes user-visible channel names into lowercase slug keys. */
export function normalizeChannelSlug(value: string): string {
  return normalizeLowercaseStringOrEmpty(value)
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Builds deduped key candidates while dropping blank/nullish entries. */
export function buildChannelKeyCandidates(...keys: Array<string | undefined | null>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(keys);
}

/** Finds direct and wildcard entries without applying parent fallback precedence. */
export function resolveChannelEntryMatch<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  wildcardKey?: string;
}): ChannelEntryMatch<T> {
  const entries = params.entries ?? {};
  const match: ChannelEntryMatch<T> = {};
  for (const key of params.keys) {
    if (!Object.hasOwn(entries, key)) {
      continue;
    }
    match.entry = entries[key];
    match.key = key;
    break;
  }
  if (params.wildcardKey && Object.hasOwn(entries, params.wildcardKey)) {
    // Keep wildcard metadata even when a direct entry exists so diagnostics can
    // explain the fallback that would have applied.
    match.wildcardEntry = entries[params.wildcardKey];
    match.wildcardKey = params.wildcardKey;
  }
  return match;
}

/** Resolves channel config by direct match, normalized direct match, parent match, then wildcard. */
export function resolveChannelEntryMatchWithFallback<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  parentKeys?: string[];
  wildcardKey?: string;
  normalizeKey?: (value: string) => string;
}): ChannelEntryMatch<T> {
  const direct = resolveChannelEntryMatch({
    entries: params.entries,
    keys: params.keys,
    wildcardKey: params.wildcardKey,
  });

  if (direct.entry && direct.key) {
    return { ...direct, matchKey: direct.key, matchSource: "direct" };
  }

  const normalizeKey = params.normalizeKey;
  if (normalizeKey) {
    // Normalized direct matching lets display names and ids converge before parent/wildcard
    // fallback can broaden the selected config.
    const normalizedKeys = params.keys.map((key) => normalizeKey(key)).filter(Boolean);
    if (normalizedKeys.length > 0) {
      for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
        const normalizedEntry = normalizeKey(entryKey);
        if (normalizedEntry && normalizedKeys.includes(normalizedEntry)) {
          // Preserve the original configured key as matchKey; callers surface it
          // in status/debug output instead of the normalized comparison key.
          return {
            ...direct,
            entry,
            key: entryKey,
            matchKey: entryKey,
            matchSource: "direct",
          };
        }
      }
    }
  }

  const parentKeys = params.parentKeys ?? [];
  if (parentKeys.length > 0) {
    const parent = resolveChannelEntryMatch({ entries: params.entries, keys: parentKeys });
    if (parent.entry && parent.key) {
      return {
        ...direct,
        entry: parent.entry,
        key: parent.key,
        parentEntry: parent.entry,
        parentKey: parent.key,
        matchKey: parent.key,
        matchSource: "parent",
      };
    }
    if (normalizeKey) {
      // Normalized parent keys keep thread/channel parent fallback consistent with direct keys.
      const normalizedParentKeys = parentKeys.map((key) => normalizeKey(key)).filter(Boolean);
      if (normalizedParentKeys.length > 0) {
        for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
          const normalizedEntry = normalizeKey(entryKey);
          if (normalizedEntry && normalizedParentKeys.includes(normalizedEntry)) {
            return {
              ...direct,
              entry,
              key: entryKey,
              parentEntry: entry,
              parentKey: entryKey,
              matchKey: entryKey,
              matchSource: "parent",
            };
          }
        }
      }
    }
  }

  if (direct.wildcardEntry && direct.wildcardKey) {
    return {
      ...direct,
      entry: direct.wildcardEntry,
      key: direct.wildcardKey,
      matchKey: direct.wildcardKey,
      matchSource: "wildcard",
    };
  }

  return direct;
}

/** Resolves nested allowlists where an unconfigured outer/inner list means "no restriction". */
export function resolveNestedAllowlistDecision(params: {
  outerConfigured: boolean;
  outerMatched: boolean;
  innerConfigured: boolean;
  innerMatched: boolean;
}): boolean {
  if (!params.outerConfigured) {
    // Unconfigured outer lists mean the whole nested policy is inactive; do not
    // require an inner match until the outer scope has opted into restriction.
    return true;
  }
  if (!params.outerMatched) {
    return false;
  }
  if (!params.innerConfigured) {
    return true;
  }
  return params.innerMatched;
}
