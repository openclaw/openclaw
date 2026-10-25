// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  minLength: number;
  maxLength: number;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  hasAlternation: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
};

const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
export type SafeRegexRejectReason = "empty" | "unsafe-nested-repetition" | "invalid-regex";

export type SafeRegexCompileResult =
  | {
      regex: RegExp;
      source: string;
      flags: string;
      reason: null;
    }
  | {
      regex: null;
      source: string;
      flags: string;
      reason: SafeRegexRejectReason;
    };

const safeRegexCache = new Map<string, SafeRegexCompileResult>();

function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAlternation: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
  };
}

function addLength(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return Number.POSITIVE_INFINITY;
  }
  return left + right;
}

function multiplyLength(length: number, factor: number): number {
  if (!Number.isFinite(length)) {
    return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
  }
  return length * factor;
}

function recordAlternative(frame: ParseFrame): void {
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}

function readQuantifier(source: string, index: number): QuantifierRead | null {
  const ch = source[index];
  const consumed = source[index + 1] === "?" ? 2 : 1;
  if (ch === "*") {
    return { consumed, minRepeat: 0, maxRepeat: null };
  }
  if (ch === "+") {
    return { consumed, minRepeat: 1, maxRepeat: null };
  }
  if (ch === "?") {
    return { consumed, minRepeat: 0, maxRepeat: 1 };
  }
  if (ch !== "{") {
    return null;
  }

  let i = index + 1;
  while (i < source.length && /\d/.test(source.charAt(i))) {
    i += 1;
  }
  if (i === index + 1) {
    return null;
  }

  const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
  let maxRepeat: number | null = minRepeat;
  if (source[i] === ",") {
    i += 1;
    const maxStart = i;
    while (i < source.length && /\d/.test(source.charAt(i))) {
      i += 1;
    }
    maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
  }

  if (source[i] !== "}") {
    return null;
  }
  i += 1;
  if (source[i] === "?") {
    i += 1;
  }
  if (maxRepeat !== null && maxRepeat < minRepeat) {
    return null;
  }

  return { consumed: i - index, minRepeat, maxRepeat };
}

function analyzeRepetition(source: string): {
  nestedQuantifier: boolean;
  ambiguousAlternation: boolean;
} {
  const result = { nestedQuantifier: false, ambiguousAlternation: false };
  const frames: ParseFrame[] = [createParseFrame()];
  let inCharClass = false;

  const emitToken = (token: TokenState) => {
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
  };

  const emitSimpleToken = () => {
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: false,
      minLength: 1,
      maxLength: 1,
    });
  };

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inCharClass) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === "]") {
        inCharClass = false;
      }
      continue;
    }
    if (ch === "\\") {
      i += 1;
      emitSimpleToken();
      continue;
    }
    if (ch === "[") {
      inCharClass = true;
      emitSimpleToken();
      continue;
    }

    if (ch === "(") {
      frames.push(createParseFrame());
      continue;
    }

    if (ch === ")") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.hasAlternation) {
          recordAlternative(frame);
        }
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        emitToken({
          containsRepetition: frame.containsRepetition,
          hasAmbiguousAlternation:
            frame.hasAlternation &&
            frame.altMinLength !== null &&
            frame.altMaxLength !== null &&
            frame.altMinLength !== frame.altMaxLength,
          minLength: groupMinLength,
          maxLength: groupMaxLength,
        });
      }
      continue;
    }

    if (ch === "|") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      recordAlternative(frame);
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.lastToken = null;
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (!quantifier) {
      emitSimpleToken();
      continue;
    }
    i += quantifier.consumed - 1;
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    const previousToken = frame.lastToken;
    if (!previousToken) {
      continue;
    }
    if (previousToken.containsRepetition) {
      result.nestedQuantifier = true;
      continue;
    }
    if (previousToken.hasAmbiguousAlternation && quantifier.maxRepeat === null) {
      result.ambiguousAlternation = true;
      continue;
    }

    const previousMinLength = previousToken.minLength;
    const previousMaxLength = previousToken.maxLength;
    previousToken.minLength = multiplyLength(previousToken.minLength, quantifier.minRepeat);
    previousToken.maxLength =
      quantifier.maxRepeat === null
        ? Number.POSITIVE_INFINITY
        : multiplyLength(previousToken.maxLength, quantifier.maxRepeat);
    previousToken.containsRepetition = true;
    frame.containsRepetition = true;
    frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;

    const branchMaxBase =
      Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
        ? frame.branchMaxLength - previousMaxLength
        : Number.POSITIVE_INFINITY;
    frame.branchMaxLength = addLength(branchMaxBase, previousToken.maxLength);
  }

  return result;
}

function hasNestedRepetition(source: string): boolean {
  const analysis = analyzeRepetition(source);
  return analysis.nestedQuantifier || analysis.ambiguousAlternation;
}

/**
 * Narrow admission predicate: true only when a quantifier repeats an atom that already
 * contains a quantifier (e.g. `(a+)+$`). Unlike {@link hasNestedRepetition}, this does not
 * apply the length-based alternation heuristic, so safe patterns such as `^(a|bc)+$` stay
 * admissible. Intended for untrusted-schema admission where false positives break honest
 * servers; operator-authored config keeps using the stricter guard.
 */
export function hasNestedQuantifierRepetition(source: string): boolean {
  return analyzeRepetition(source).nestedQuantifier;
}

type BranchStartSet = { any: boolean; chars: Set<string> };

type AlternationBranch = {
  firstSet: BranchStartSet;
  /** Exact matched string when the branch is a pure literal concat; null when complex. */
  literal: string | null;
  nullable: boolean;
};

const WORD_CLASS_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_";
const DIGIT_CLASS_CHARS = "0123456789";
const SPACE_CLASS_CHARS = " \t\n\r\f\v";
const CLASS_MATERIALIZE_LIMIT = 256;

function singletonBranchSet(char: string): BranchStartSet {
  return { any: false, chars: new Set([char]) };
}

const ANY_BRANCH_SET: BranchStartSet = { any: true, chars: new Set() };
const EMPTY_BRANCH_SET: BranchStartSet = { any: false, chars: new Set() };

function unionBranchSets(left: BranchStartSet, right: BranchStartSet): BranchStartSet {
  if (left.any || right.any) {
    return ANY_BRANCH_SET;
  }
  return { any: false, chars: new Set([...left.chars, ...right.chars]) };
}

function branchSetsOverlap(left: BranchStartSet, right: BranchStartSet): boolean {
  if (left.any || right.any) {
    return true;
  }
  for (const char of left.chars) {
    if (right.chars.has(char)) {
      return true;
    }
  }
  return false;
}

function classBranchSet(letter: string): BranchStartSet {
  const chars =
    letter === "d" || letter === "D"
      ? DIGIT_CLASS_CHARS
      : letter === "w" || letter === "W"
        ? WORD_CLASS_CHARS
        : SPACE_CLASS_CHARS;
  if (letter === "D" || letter === "W" || letter === "S") {
    return ANY_BRANCH_SET;
  }
  return { any: false, chars: new Set(chars) };
}

function isHexDigit(char: string | undefined): boolean {
  return char !== undefined && /[0-9a-fA-F]/.test(char);
}

function readHexEscape(source: string, start: number, length: number): string | null {
  if (start + length > source.length) {
    return null;
  }
  const digits = source.slice(start, start + length);
  if (![...digits].every(isHexDigit)) {
    return null;
  }
  return String.fromCharCode(Number.parseInt(digits, 16));
}

/** Read a `[...]` character class starting at `openIndex`; null when malformed (unterminated). */
function readClassStartSet(
  source: string,
  openIndex: number,
): { set: BranchStartSet; literalChar: string | null; endIndex: number } | null {
  let i = openIndex + 1;
  let negated = false;
  if (source[i] === "^") {
    negated = true;
    i += 1;
  }
  const chars = new Set<string>();
  let first = true;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "]" && !first) {
      if (negated) {
        return { set: ANY_BRANCH_SET, literalChar: null, endIndex: i };
      }
      if (chars.size === 0) {
        return null;
      }
      if (chars.size > CLASS_MATERIALIZE_LIMIT) {
        return { set: ANY_BRANCH_SET, literalChar: null, endIndex: i };
      }
      return {
        set: { any: false, chars },
        literalChar: chars.size === 1 ? [...chars][0] : null,
        endIndex: i,
      };
    }
    first = false;
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "d" || next === "D" || next === "w" || next === "W" || next === "s" || next === "S") {
        const set = classBranchSet(next);
        if (set.any) {
          return { set: ANY_BRANCH_SET, literalChar: null, endIndex: source.length };
        }
        for (const char of set.chars) {
          chars.add(char);
        }
        i += 2;
        continue;
      }
      if (next === "x") {
        const escaped = readHexEscape(source, i + 2, 2);
        if (escaped === null) {
          return null;
        }
        chars.add(escaped);
        i += 4;
        continue;
      }
      if (next === "u") {
        const escaped = readHexEscape(source, i + 2, 4);
        if (escaped === null) {
          return null;
        }
        chars.add(escaped);
        i += 6;
        continue;
      }
      if (next === undefined) {
        return null;
      }
      chars.add(next);
      i += 2;
      continue;
    }
    if (source[i + 1] === "-" && source[i + 2] !== undefined && source[i + 2] !== "]") {
      const lo = ch.codePointAt(0);
      const hi = source[i + 2].codePointAt(0);
      if (lo === undefined || hi === undefined || hi - lo > CLASS_MATERIALIZE_LIMIT) {
        return { set: ANY_BRANCH_SET, literalChar: null, endIndex: source.length };
      }
      for (let code = lo; code <= hi; code += 1) {
        chars.add(String.fromCodePoint(code));
      }
      i += 3;
      continue;
    }
    chars.add(ch);
    i += 1;
  }
  return null;
}

type OverlapFrame = {
  sawAlternation: boolean;
  branches: AlternationBranch[];
  firstSet: BranchStartSet;
  literal: string | null;
  startDecided: boolean;
  hasToken: boolean;
  /** Branches of the most recently closed alternation group awaiting a possible quantifier. */
  pendingAlternation: AlternationBranch[] | null;
};

function createOverlapFrame(): OverlapFrame {
  return {
    sawAlternation: false,
    branches: [],
    firstSet: EMPTY_BRANCH_SET,
    literal: "",
    startDecided: false,
    hasToken: false,
    pendingAlternation: null,
  };
}

function finalizeBranch(frame: OverlapFrame): AlternationBranch {
  if (!frame.hasToken) {
    // Empty alternative: matches the empty string, so it overlaps every other branch.
    return { firstSet: ANY_BRANCH_SET, literal: "", nullable: true };
  }
  return {
    firstSet: frame.firstSet,
    literal: frame.literal,
    nullable: !frame.startDecided,
  };
}

function alternationBranchesAmbiguous(branches: AlternationBranch[]): boolean {
  for (let a = 0; a < branches.length; a += 1) {
    for (let b = a + 1; b < branches.length; b += 1) {
      const left = branches[a];
      const right = branches[b];
      if (!branchSetsOverlap(left.firstSet, right.firstSet)) {
        // Disjoint first characters: at any input position at most one branch can match.
        continue;
      }
      if (left.literal !== null && right.literal !== null) {
        // Same first character; deterministic unless one literal is a prefix of the other.
        if (left.literal.startsWith(right.literal) || right.literal.startsWith(left.literal)) {
          return true;
        }
        continue;
      }
      return true;
    }
  }
  return false;
}

/**
 * Detect alternation groups repeated by an unbounded quantifier whose branches can match the
 * same input position — the alternation form of catastrophic backtracking (e.g. `(a|aa)+$`).
 * Branches that start with disjoint characters are provably deterministic per input position;
 * same-start literal branches are ambiguous only when one is a prefix of the other. Branches
 * involving classes, groups, or unbounded tokens fall back to conservative overlap detection.
 * Returns false for malformed sources: invalid patterns never execute, so their diagnostics
 * stay with the validation engines.
 */
export function hasAmbiguousAlternationOverlap(source: string): boolean {
  const frames: OverlapFrame[] = [createOverlapFrame()];
  const frame = () => frames[frames.length - 1];

  const consumeToken = (
    firstSet: BranchStartSet,
    literalPiece: string | null,
    nullable: boolean,
  ) => {
    const current = frame();
    if (!current.startDecided) {
      current.firstSet = unionBranchSets(current.firstSet, firstSet);
      if (!nullable) {
        current.startDecided = true;
      }
    }
    if (literalPiece === null || nullable) {
      current.literal = null;
    } else if (current.literal !== null) {
      current.literal += literalPiece;
    }
    current.hasToken = true;
    current.pendingAlternation = null;
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === "b" || next === "B") {
        i += 2;
        continue;
      }
      if (next === undefined) {
        return false;
      }
      if (next === "d" || next === "D" || next === "w" || next === "W" || next === "s" || next === "S") {
        consumeToken(classBranchSet(next), null, false);
        i += 2;
        continue;
      }
      if (/\d/.test(next)) {
        // Backreference or named-group reference: unknown start.
        consumeToken(ANY_BRANCH_SET, null, false);
        i += 2;
        continue;
      }
      if (next === "k") {
        consumeToken(ANY_BRANCH_SET, null, false);
        i += 2;
        continue;
      }
      if (next === "x") {
        const escaped = readHexEscape(source, i + 2, 2);
        if (escaped === null) {
          return false;
        }
        consumeToken(singletonBranchSet(escaped), escaped, false);
        i += 4;
        continue;
      }
      if (next === "u") {
        const escaped = readHexEscape(source, i + 2, 4);
        if (escaped === null) {
          return false;
        }
        consumeToken(singletonBranchSet(escaped), escaped, false);
        i += 6;
        continue;
      }
      consumeToken(singletonBranchSet(next), next, false);
      i += 2;
      continue;
    }
    if (ch === "[") {
      const cls = readClassStartSet(source, i);
      if (!cls) {
        return false;
      }
      consumeToken(cls.set, cls.literalChar, false);
      i = cls.endIndex + 1;
      continue;
    }
    if (ch === ".") {
      consumeToken(ANY_BRANCH_SET, null, false);
      i += 1;
      continue;
    }
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      if (source[i + 1] === "?") {
        const marker = source[i + 2];
        if (marker === ":") {
          frames.push(createOverlapFrame());
          i += 3;
          continue;
        }
        if (marker === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") {
          // Named capturing group: (?<name>...)
          const close = source.indexOf(">", i + 3);
          if (close === -1) {
            return false;
          }
          frames.push(createOverlapFrame());
          i = close + 1;
          continue;
        }
        // Lookahead/lookbehind: opaque zero-width assertion with an unknown start set.
        let depth = 1;
        let j = i + 2;
        while (j < source.length && depth > 0) {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          if (source[j] === "(") {
            depth += 1;
          } else if (source[j] === ")") {
            depth -= 1;
          }
          j += 1;
        }
        if (depth !== 0) {
          return false;
        }
        consumeToken(ANY_BRANCH_SET, null, true);
        i = j;
        continue;
      }
      frames.push(createOverlapFrame());
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (frames.length === 1) {
        return false;
      }
      const closed = frames.pop();
      const parent = frame();
      const branch = finalizeBranch(closed);
      if (closed.sawAlternation) {
        const allBranches = [...closed.branches, branch];
        const firstSet = allBranches
          .map((entry) => entry.firstSet)
          .reduce((acc, entry) => unionBranchSets(acc, entry), EMPTY_BRANCH_SET);
        consumeToken(firstSet, null, allBranches.some((entry) => entry.nullable));
        parent.pendingAlternation = allBranches;
      } else {
        consumeToken(branch.firstSet, branch.nullable ? null : branch.literal, branch.nullable);
      }
      i += 1;
      continue;
    }
    if (ch === "|") {
      const current = frame();
      current.sawAlternation = true;
      current.branches.push(finalizeBranch(current));
      current.firstSet = EMPTY_BRANCH_SET;
      current.literal = "";
      current.startDecided = false;
      current.hasToken = false;
      current.pendingAlternation = null;
      i += 1;
      continue;
    }
    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      const current = frame();
      if (!current.hasToken && current.pendingAlternation === null) {
        // Quantifier without a preceding atom: malformed pattern.
        return false;
      }
      if (
        quantifier.maxRepeat === null &&
        current.pendingAlternation &&
        alternationBranchesAmbiguous(current.pendingAlternation)
      ) {
        return true;
      }
      if (quantifier.minRepeat === 0) {
        // The preceding atom became nullable, which makes the branch multi-string.
        current.literal = null;
        if (!current.startDecided) {
          current.firstSet = ANY_BRANCH_SET;
        }
      }
      current.pendingAlternation = null;
      i += quantifier.consumed;
      continue;
    }
    consumeToken(singletonBranchSet(ch), ch, false);
    i += 1;
  }
  return frames.length === 1 ? false : false;
}

function testRegexFromStart(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

export function testRegexWithBoundedInput(regex: RegExp, input: string): boolean {
  if (input.length <= SAFE_REGEX_TEST_WINDOW) {
    return testRegexFromStart(regex, input);
  }
  const head = input.slice(0, SAFE_REGEX_TEST_WINDOW);
  if (testRegexFromStart(regex, head)) {
    return true;
  }
  return testRegexFromStart(regex, input.slice(-SAFE_REGEX_TEST_WINDOW));
}

export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }
  const cacheKey = `${flags}::${trimmed}`;
  const cached = safeRegexCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let result: SafeRegexCompileResult;
  if (hasNestedRepetition(trimmed)) {
    result = { regex: null, source: trimmed, flags, reason: "unsafe-nested-repetition" };
  } else {
    try {
      result = { regex: new RegExp(trimmed, flags), source: trimmed, flags, reason: null };
    } catch {
      result = { regex: null, source: trimmed, flags, reason: "invalid-regex" };
    }
  }

  safeRegexCache.set(cacheKey, result);
  pruneMapToMaxSize(safeRegexCache, SAFE_REGEX_CACHE_MAX);
  return result;
}

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}
