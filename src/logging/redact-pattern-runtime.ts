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

const OPEN_REPEAT_RE = /^\{(\d+),\}/;
const BOUNDED_REPEAT_RE = /^\{(?:\d+(?:,\d*)?|,\d+)\}/;
const HEX_DIGIT_RE = /[0-9A-Fa-f]/;
const ASSERTION_ESCAPE_CHARS = new Set(["b", "B"]);

const escapeHexValue = (source: string, at: number): number | null => {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    const digit = source[at + index];
    if (digit === undefined || !HEX_DIGIT_RE.test(digit)) {
      return null;
    }
    value = value * 16 + Number.parseInt(digit, 16);
  }
  return value;
};

/** True when the escape at `i` is a `\uXXXX` high-surrogate escape. */
const isHighSurrogateEscape = (source: string, i: number): boolean => {
  const value = escapeHexValue(source, i + 2);
  return value !== null && value >= 0xd800 && value <= 0xdbff;
};

/** True when the escape at `i` is a `\uXXXX` low-surrogate escape. */
const isLowSurrogateEscape = (source: string, i: number): boolean => {
  const value = escapeHexValue(source, i + 2);
  return value !== null && value >= 0xdc00 && value <= 0xdfff;
};

/** End index (exclusive) of the single atom introduced by the escape at `i` (a backslash), or -1. */
function escapeAtomEnd(source: string, i: number): number {
  const kind = source[i + 1];
  if (kind === undefined) {
    return -1;
  }
  if (ASSERTION_ESCAPE_CHARS.has(kind)) {
    return i + 2;
  }
  if (kind === "x") {
    return HEX_DIGIT_RE.test(source[i + 2] ?? "") && HEX_DIGIT_RE.test(source[i + 3] ?? "")
      ? i + 4
      : i + 2;
  }
  if ((kind === "u" || kind === "p" || kind === "P") && source[i + 2] === "{") {
    const close = source.indexOf("}", i + 3);
    return close === -1 ? i + 2 : close + 1;
  }
  if (kind === "u") {
    let end = i + 2;
    while (end < i + 6 && HEX_DIGIT_RE.test(source[end] ?? "")) {
      end += 1;
    }
    return end;
  }
  if (kind === "c") {
    return i + 3;
  }
  if (kind === "k" && source[i + 2] === "<") {
    // A named backreference `\k<name>` is one complete atom; a following quantifier must
    // treat the whole reference (not just `\k`) as the repeated atom.
    const close = source.indexOf(">", i + 3);
    return close === -1 ? i + 2 : close + 1;
  }
  if (kind >= "0" && kind <= "9") {
    let end = i + 2;
    for (let cursor = end; cursor < source.length; cursor += 1) {
      const digit = source[cursor];
      if (digit === undefined || digit < "0" || digit > "9") {
        break;
      }
      end = cursor + 1;
    }
    return end;
  }
  return i + 2;
}

/** End index (exclusive) of the character class starting at `i` (an unescaped bracket). */
function classAtomEnd(source: string, i: number): number {
  let cursor = i + 1;
  if (source[cursor] === "^") {
    cursor += 1;
  }
  if (source[cursor] === "]") {
    // `[]` and `[^]` are valid JavaScript classes this atom parser does not model; report
    // the source as unsupported so the rewrite leaves it unchanged and the configured
    // pattern keeps its exact language.
    return -1;
  }
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === "\\") {
      cursor += 2;
      continue;
    }
    if (char === "]") {
      return cursor + 1;
    }
    cursor += 1;
  }
  return source.length;
}

/**
 * Rewrites open-ended repeats `X{n,}` into `X{n}X*` for flat single-character atoms `X`
 * (one literal, one escaped atom, or one bracket class). Greedy `X{n,}` and `X{n}X*`
 * accept the same strings in the same backtracking order, but the latter never grows one
 * backtrack stack entry per repetition, so multi-megabyte runs no longer overflow.
 * Bounded repeats, quantifiers after groups, and quantified atoms are left untouched.
 * `flags` decides atom boundaries for literal astral characters: under `u` a surrogate pair
 * is one atom; without `u` JavaScript quantifies only the trailing code unit, so the pair
 * must keep its per-unit handling and the original language.
 */
export function rewriteOpenEndedRepeats(source: string, flags = ""): string {
  if (!source.includes("{")) {
    return source;
  }
  let out = "";
  // Half-open [atomStart, atomEnd) span of the current flat single-character atom, if any.
  let atomStart = -1;
  let atomEnd = -1;
  let i = 0;
  while (i < source.length) {
    const char = source[i]!;
    if (char === "\\") {
      // Only canonical built-in sources reach this rewriter; operator-configured sources
      // compile unmodified at the caller, so their legacy escape and class boundaries keep
      // their exact language. The escape handling below is exact for the built-in sources.
      const end = escapeAtomEnd(source, i);
      if (end < 0) {
        out += char;
        i += 1;
        atomStart = -1;
        continue;
      }
      // Adjacent `\uD83D\uDE00` escapes form one complete atom under the `u` flag: a
      // following quantifier must repeat the pair, not its trailing code unit. Rewriting
      // them independently changes the configured pattern's language.
      if (
        flags.includes("u") &&
        isHighSurrogateEscape(source, i) &&
        source[end] === "\\" &&
        isLowSurrogateEscape(source, end)
      ) {
        const pairEnd = escapeAtomEnd(source, end);
        out += source.slice(i, pairEnd);
        atomStart = i;
        atomEnd = pairEnd;
        i = pairEnd;
        continue;
      }
      out += source.slice(i, end);
      if (ASSERTION_ESCAPE_CHARS.has(source[i + 1]!)) {
        atomStart = -1;
      } else {
        atomStart = i;
        atomEnd = end;
      }
      i = end;
      continue;
    }
    if (char === "[") {
      const end = classAtomEnd(source, i);
      if (end < 0) {
        // Unsupported class shape: report the source as unsupported so the rewrite leaves
        // the configured expression unchanged and the pattern keeps its exact language.
        return source;
      }
      out += source.slice(i, end);
      atomStart = i;
      atomEnd = end;
      i = end;
      continue;
    }
    if (char === "{") {
      const open = OPEN_REPEAT_RE.exec(source.slice(i));
      if (open && atomStart >= 0) {
        const atom = source.slice(atomStart, atomEnd);
        out += `{${open[1]}}${atom}*`;
        i += open[0].length;
        if (source[i] === "?") {
          out += "?";
          i += 1;
        }
        atomStart = -1;
        continue;
      }
      const bounded = BOUNDED_REPEAT_RE.exec(source.slice(i));
      if (bounded) {
        out += bounded[0];
        i += bounded[0].length;
        if (source[i] === "?") {
          out += "?";
          i += 1;
        }
        atomStart = -1;
        continue;
      }
      // A brace that is neither quantifier is a literal single-character atom.
      out += char;
      atomStart = i;
      atomEnd = i + 1;
      i += 1;
      continue;
    }
    out += char;
    // A literal astral character is one atom only under the `u` flag: with `u`, a surrogate
    // pair is a single code point, so splitting it between a quantifier and its atom changes
    // the pattern's language. Without `u`, JavaScript quantifies only the trailing code unit,
    // so the pair must keep its per-unit handling and the original language.
    if (
      flags.includes("u") &&
      char >= "\uD800" &&
      char <= "\uDBFF" &&
      i + 1 < source.length &&
      source[i + 1]! >= "\uDC00" &&
      source[i + 1]! <= "\uDFFF"
    ) {
      out += source[i + 1]!;
      atomStart = i;
      atomEnd = i + 2;
      i += 2;
      continue;
    }
    if (
      char === "*" ||
      char === "+" ||
      char === "?" ||
      char === "(" ||
      char === ")" ||
      char === "|" ||
      char === "^" ||
      char === "$"
    ) {
      atomStart = -1;
    } else {
      atomStart = i;
      atomEnd = i + 1;
    }
    i += 1;
  }
  return out;
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

// The shared compiler exposes mutable regexes; probes remain valid only for their original rule.
const patternPrefilters = new WeakMap<ResolvedRedactPattern, (text: string) => boolean>();

export function setRedactPatternPrefilter(
  pattern: ResolvedRedactPattern,
  probe: (text: string) => boolean,
): void {
  if (patternPrefilters.has(pattern)) {
    return;
  }
  const source = pattern.source;
  const exec = pattern.exec;
  const flags = pattern instanceof RegExp ? pattern.flags : undefined;
  const replace = pattern instanceof RegExp ? pattern[Symbol.replace] : undefined;
  patternPrefilters.set(
    pattern,
    (text) =>
      pattern.source !== source ||
      pattern.exec !== exec ||
      (pattern instanceof RegExp &&
        (pattern.flags !== flags || pattern[Symbol.replace] !== replace)) ||
      probe(text),
  );
}

// Derived matchers live only as long as their owner pattern, never as long as a secret value.
const indexedPatterns = new WeakMap<RegExp, RegExp>();

function getIndexedCaptureStart(
  pattern: ResolvedRedactPattern,
  input: string,
  match: string,
  matchOffset: number,
  captureIndex: number,
): number | null {
  if (!(pattern instanceof RegExp) || matchOffset < 0 || !input) {
    return null;
  }
  let indexedPattern = indexedPatterns.get(pattern);
  if (!indexedPattern) {
    indexedPattern = new RegExp(
      pattern.source,
      `${pattern.flags.replace("d", "").replace("g", "")}dg`,
    );
    indexedPatterns.set(pattern, indexedPattern);
  }
  indexedPattern.lastIndex = matchOffset;
  const indexedMatch = indexedPattern.exec(input);
  const captureIndices = indexedMatch?.indices?.[captureIndex + 1];
  return indexedMatch?.index === matchOffset && indexedMatch[0] === match && captureIndices
    ? captureIndices[0] - matchOffset
    : null;
}

type SecretCaptureSelection = {
  index: number;
  value: string;
};

export function selectSecretCapture(match: string, groups: string[]): SecretCaptureSelection {
  const selected = { index: -1, value: match };
  for (let index = 0; index < groups.length; index++) {
    const value = groups[index];
    if (typeof value === "string" && value.length > 0) {
      selected.index = index;
      selected.value = value;
    }
  }
  return selected;
}

export function getSecretCaptureStart(
  pattern: ResolvedRedactPattern,
  input: string,
  match: string,
  matchOffset: number,
  selected: SecretCaptureSelection,
): number {
  const indexedTokenStart = getIndexedCaptureStart(
    pattern,
    input,
    match,
    matchOffset,
    selected.index,
  );
  return indexedTokenStart ?? match.lastIndexOf(selected.value);
}

const globalPatterns = new WeakMap<RegExp, RegExp>();

export function visitRedactMatches(
  text: string,
  pattern: ResolvedRedactPattern,
  visit: (match: RedactMatch, pattern: ResolvedRedactPattern) => void,
): void {
  if (patternPrefilters.get(pattern)?.(text) === false) {
    return;
  }
  if (!(pattern instanceof RegExp)) {
    for (const match of pattern.exec(text)) {
      visit(match, pattern);
    }
    return;
  }
  let regex = pattern.global ? pattern : globalPatterns.get(pattern);
  if (!regex) {
    regex = new RegExp(pattern.source, `${pattern.flags}g`);
    globalPatterns.set(pattern, regex);
  }
  const unicode = regex.unicode || regex.flags.includes("v");
  let cursor = 0;
  while (cursor <= text.length) {
    const previousIndex = regex.lastIndex;
    let match: RegExpExecArray | null;
    // A visitor can re-enter this scanner with the same compiled expression.
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
    visit(
      {
        match: match[0],
        groups: match.slice(1).map((group) => group ?? ""),
        input: text,
        offset: match.index,
      },
      pattern,
    );
  }
}

export function replaceRedactPattern(
  text: string,
  pattern: ResolvedRedactPattern,
  replace: (match: RedactMatch) => string,
  replaceRegex?: (...args: unknown[]) => string,
): string {
  if (pattern instanceof RegExp) {
    if (patternPrefilters.get(pattern)?.(text) === false) {
      // Attached regexes are compiled global; native replacement resets even on a miss.
      pattern.lastIndex = 0;
      return text;
    }
    return text.replace(
      pattern,
      replaceRegex ?? ((...args: unknown[]) => replace(readRedactMatch(args))),
    );
  }
  const parts: string[] = [];
  let end = 0;
  visitRedactMatches(text, pattern, (match) => {
    parts.push(text.slice(end, match.offset), replace(match));
    end = match.offset + match.match.length;
  });
  return parts.length ? parts.join("") + text.slice(end) : text;
}

export function redactPemBlock(block: string, marker: string): string {
  const lines = block.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return "***";
  }
  return `${lines[0]}\n${marker}\n${lines[lines.length - 1]}`;
}
