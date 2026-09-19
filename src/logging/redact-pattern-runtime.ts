// Browser-safe pattern mechanics; callers retain compilation and masking policy.
export function parseRedactPatternSource(raw: string): [source: string, flags: string] {
  const literal = raw.match(/^\/(.+)\/([gimsuy]*)$/);
  if (!literal) {
    return [raw, "gi"];
  }
  const source = literal[1] ?? "";
  const flags = literal[2] ?? "";
  return [source, flags.includes("g") ? flags : `${flags}g`];
}

export function readRedactMatch(args: unknown[]) {
  const hasNamedGroups =
    args.length > 0 && typeof args[args.length - 1] === "object" && args[args.length - 1] !== null;
  const inputIndex = hasNamedGroups ? args.length - 2 : args.length - 1;
  const offsetIndex = inputIndex - 1;
  const match = typeof args[0] === "string" ? args[0] : "";
  const groups = args
    .slice(1, offsetIndex)
    .map((value) => (typeof value === "string" ? value : ""));
  const offset = typeof args[offsetIndex] === "number" ? args[offsetIndex] : -1;
  const input = typeof args[inputIndex] === "string" ? args[inputIndex] : "";
  return { match, groups, input, offset };
}

export type RedactMatch = ReturnType<typeof readRedactMatch> & { replacement?: string };

/**
 * Programmatic synchronous rule; never serialized into logging.redactPatterns.
 * Each call uses its current input and fresh local state. Yield nonempty exact
 * matches in order without overlap, with UTF-16 offsets and that same input.
 * groups uses "" for unmatched captures; the last nonempty capture selects the
 * secret's last occurrence in match, or an empty array selects the whole match.
 * replacement carries a fixed policy mask; absent values use the caller's token hints.
 */
type RedactMatcher = {
  readonly source: string;
  readonly exec: (text: string) => Iterable<RedactMatch>;
  readonly createContext?: () => {
    pattern: ResolvedRedactPattern;
    /** Prepend one complete, newline-bounded source block; true means older input cannot matter. */
    prepend: () => { consume: (text: string) => void; finish: () => boolean };
  };
};
export type ResolvedRedactPattern = RegExp | RedactMatcher;
export type RedactPattern = string | ResolvedRedactPattern;

export function getIndexedCaptureStart(
  pattern: ResolvedRedactPattern,
  input: string,
  match: string,
  matchOffset: number,
  captureIndex: number,
): number | null {
  if (!(pattern instanceof RegExp) || matchOffset < 0 || !input) {
    return null;
  }
  try {
    const flags = pattern.flags.includes("d") ? pattern.flags : `${pattern.flags}d`;
    const indexedPattern = new RegExp(pattern.source, flags);
    indexedPattern.lastIndex = matchOffset;
    const indexedMatch = indexedPattern.exec(input);
    const captureIndices = indexedMatch?.indices?.[captureIndex + 1];
    if (!indexedMatch || indexedMatch.index !== matchOffset || indexedMatch[0] !== match) {
      return null;
    }
    if (!captureIndices) {
      return null;
    }
    return captureIndices[0] - matchOffset;
  } catch {
    return null;
  }
}

const globalPatterns = new WeakMap<RegExp, RegExp>();

export function* iterateRedactMatches(
  text: string,
  pattern: ResolvedRedactPattern,
): Iterable<RedactMatch> {
  if (!(pattern instanceof RegExp)) {
    yield* pattern.exec(text);
    return;
  }
  let regex = pattern;
  if (!pattern.global) {
    const cached = globalPatterns.get(pattern);
    regex = cached ?? new RegExp(pattern.source, `${pattern.flags}g`);
    if (!cached) {
      globalPatterns.set(pattern, regex);
    }
  }
  const unicode = regex.unicode || regex.flags.includes("v");
  let cursor = 0;
  while (cursor <= text.length) {
    const previousIndex = regex.lastIndex;
    let match: RegExpExecArray | null;
    // A yielded match can re-enter this scanner with the same compiled expression.
    try {
      regex.lastIndex = cursor;
      match = regex.exec(text);
    } finally {
      regex.lastIndex = previousIndex;
    }
    if (!match) {
      return;
    }
    cursor = match.index + match[0].length;
    if (!match[0]) {
      const codePoint = text.codePointAt(cursor);
      cursor += unicode && codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    }
    yield {
      match: match[0],
      groups: match.slice(1).map((group) => group ?? ""),
      input: text,
      offset: match.index,
    };
  }
}

export function replaceRedactPattern(
  text: string,
  pattern: ResolvedRedactPattern,
  replace: (match: RedactMatch) => string,
  replaceRegex?: (...args: unknown[]) => string,
): string {
  if (pattern instanceof RegExp) {
    return text.replace(
      pattern,
      replaceRegex ?? ((...args: unknown[]) => replace(readRedactMatch(args))),
    );
  }
  const parts: string[] = [];
  let end = 0;
  for (const match of iterateRedactMatches(text, pattern)) {
    parts.push(text.slice(end, match.offset), replace(match));
    end = match.offset + match.match.length;
  }
  return parts.length ? parts.join("") + text.slice(end) : text;
}

export function redactPemBlock(block: string, marker: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n${marker}\n${lines[lines.length - 1]}`;
}
