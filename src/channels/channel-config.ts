/**
 * Channel config matching helpers.
 *
 * Resolves direct, parent, normalized, and wildcard config entries with match metadata.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

/** How a channel config entry was selected. */
export type ChannelMatchSource = "direct" | "parent" | "wildcard";

/** Match result carrying direct, parent, and wildcard candidates for channel config lookup. */
export type ChannelEntryMatch<T> = {
  entry?: T;
  key?: string;
  wildcardEntry?: T;
  wildcardKey?: string;
  parentEntry?: T;
  parentKey?: string;
  matchKey?: string;
  matchSource?: ChannelMatchSource;
};

/** Copies match metadata onto resolved channel config output. */
export function applyChannelMatchMeta<
  TResult extends { matchKey?: string; matchSource?: ChannelMatchSource },
>(result: TResult, match: ChannelEntryMatch<unknown>): TResult {
  if (match.matchKey && match.matchSource) {
    result.matchKey = match.matchKey;
    result.matchSource = match.matchSource;
  }
  return result;
}

/** Resolves a matched entry and preserves the config key that selected it. */
export function resolveChannelMatchConfig<
  TEntry,
  TResult extends { matchKey?: string; matchSource?: ChannelMatchSource },
>(match: ChannelEntryMatch<TEntry>, resolveEntry: (entry: TEntry) => TResult): TResult | null {
  if (!match.entry) {
    return null;
  }
  return applyChannelMatchMeta(resolveEntry(match.entry), match);
}

/** Normalizes human channel names into config-safe slugs. */
export function normalizeChannelSlug(value: string): string {
  return normalizeLowercaseStringOrEmpty(value)
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Builds unique config lookup keys from optional channel/account identifiers. */
export function buildChannelKeyCandidates(...keys: Array<string | undefined | null>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(keys);
}

/** Finds a direct channel entry and separately carries a wildcard fallback candidate. */
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
    match.wildcardEntry = entries[params.wildcardKey];
    match.wildcardKey = params.wildcardKey;
  }
  return match;
}

/** Resolves config entry precedence: direct, normalized direct, parent, normalized parent, wildcard. */
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

  for (const source of ["direct", "parent"] as const) {
    const keys = source === "direct" ? params.keys : (params.parentKeys ?? []);
    const candidate =
      source === "direct" ? direct : resolveChannelEntryMatch({ entries: params.entries, keys });
    let found = candidate.entry && candidate.key ? candidate : undefined;
    const normalizeKey = params.normalizeKey;
    if (!found && normalizeKey) {
      const normalizedKeys = keys.map((key) => normalizeKey(key)).filter(Boolean);
      if (normalizedKeys.length > 0) {
        for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
          const normalizedEntry = normalizeKey(entryKey);
          if (normalizedEntry && normalizedKeys.includes(normalizedEntry)) {
            found = { entry, key: entryKey };
            break;
          }
        }
      }
    }
    if (found) {
      return {
        ...direct,
        entry: found.entry,
        key: found.key,
        ...(source === "parent" ? { parentEntry: found.entry, parentKey: found.key } : {}),
        matchKey: found.key,
        matchSource: source,
      };
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

/** Resolves nested allowlists where an inner list only applies after the outer list matches. */
export function resolveNestedAllowlistDecision(params: {
  outerConfigured: boolean;
  outerMatched: boolean;
  innerConfigured: boolean;
  innerMatched: boolean;
}): boolean {
  if (!params.outerConfigured) {
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
