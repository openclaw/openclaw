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

export type RedactMatch = ReturnType<typeof readRedactMatch>;

/**
 * Programmatic synchronous rule; never serialized into logging.redactPatterns.
 * Each call uses its current input and fresh local state. Yield nonempty exact
 * matches in order without overlap, with UTF-16 offsets and that same input.
 * groups uses "" for unmatched captures; the last nonempty capture selects the
 * secret's last occurrence in match, or an empty array selects the whole match.
 */
export type RedactMatcher = {
  readonly source: string;
  readonly exec: (text: string) => Iterable<RedactMatch>;
};
export type ResolvedRedactPattern = RegExp | RedactMatcher;
export type RedactPattern = string | ResolvedRedactPattern;

export function* iterateRedactMatches(
  text: string,
  pattern: ResolvedRedactPattern,
): Iterable<RedactMatch> {
  if (!(pattern instanceof RegExp)) {
    yield* pattern.exec(text);
    return;
  }
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  for (const match of text.matchAll(new RegExp(pattern.source, flags))) {
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
): string {
  if (pattern instanceof RegExp) {
    return text.replace(pattern, (...args: unknown[]) => replace(readRedactMatch(args)));
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
