export type ChannelMatchSource = "direct" | "parent" | "wildcard";

export function buildChannelKeyCandidates(
  ...keys: Array<string | undefined | null>
): string[] {
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

export function buildChannelKeyCandidates(
  ...keys: Array<string | undefined | null>
): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    candidates.push(trimmed);
  }
  return candidates;
}

export function resolveChannelEntryMatch<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  wildcardKey?: string;
}): ChannelEntryMatch<T> {
  const entries = params.entries ?? {};
  const match: ChannelEntryMatch<T> = {};
  for (const key of params.keys) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
    match.entry = entries[key];
    match.key = key;
    break;
  }
  if (params.wildcardKey && Object.prototype.hasOwnProperty.call(entries, params.wildcardKey)) {
    match.wildcardEntry = entries[params.wildcardKey];
    match.wildcardKey = params.wildcardKey;
  }
  return match;
}

export function resolveChannelEntryMatchWithFallback<T>(params: {
  entries?: Record<string, T>;
  keys: string[];
  parentKeys?: string[];
  wildcardKey?: string;
}): ChannelEntryMatch<T> {
  const direct = resolveChannelEntryMatch({
    entries: params.entries,
    keys: params.keys,
    wildcardKey: params.wildcardKey,
  });

  if (direct.entry && direct.key) {
    return { ...direct, matchKey: direct.key, matchSource: "direct" };
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
