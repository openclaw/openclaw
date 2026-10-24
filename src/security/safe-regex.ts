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
  hasDuplicateAlternatives: boolean;
  minLength: number;
  maxLength: number;
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  hasAlternation: boolean;
  hasDuplicateAlternatives: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
  branchSources: string[];
  currentBranchStart: number;
};

const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
const MAX_DUPLICATE_ALTERNATIVE_REPEAT = 8;
export type SafeRegexRejectReason =
  | "empty"
  | "unsafe-nested-repetition"
  | "unsafe-ambiguous-alternation"
  | "invalid-regex";

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

function createParseFrame(currentBranchStart: number): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAlternation: false,
    hasDuplicateAlternatives: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
    branchSources: [],
    currentBranchStart,
  };
}

/**
 * Detects alternatives that are byte-identical inside the same group.
 * A quantified group with identical alternatives (`(a|a)*`) matches the same
 * strings through several paths, so the regex engine explores exponentially
 * many partitions before failing. Such a group is always redundant, so
 * rejecting it never removes a meaningful pattern.
 */
function hasDuplicateBranchSources(branchSources: string[]): boolean {
  if (branchSources.length < 2) {
    return false;
  }
  const seen = new Set<string>();
  for (const branch of branchSources) {
    if (seen.has(branch)) {
      return true;
    }
    seen.add(branch);
  }
  return false;
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

function detectUnsafeRepetition(
  source: string,
): "unsafe-nested-repetition" | "unsafe-ambiguous-alternation" | null {
  const frames: ParseFrame[] = [createParseFrame(0)];
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
      hasDuplicateAlternatives: false,
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
      frames.push(createParseFrame(i + 1));
      continue;
    }

    if (ch === ")") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        frame.branchSources.push(source.slice(frame.currentBranchStart, i));
        frame.hasDuplicateAlternatives = hasDuplicateBranchSources(frame.branchSources);
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
          hasDuplicateAlternatives: frame.hasDuplicateAlternatives,
          minLength: groupMinLength,
          maxLength: groupMaxLength,
        });
      }
      continue;
    }

    if (ch === "|") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      frame.branchSources.push(source.slice(frame.currentBranchStart, i));
      frame.currentBranchStart = i + 1;
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
      return "unsafe-nested-repetition";
    }
    // Duplicate-alternative groups only become exponential when the repeat count grows with
    // the input; a small finite bound (`?`, `{2}`, `{2,3}`) multiplies the branches by a
    // constant, so those patterns stay compilable and existing custom masks keep working.
    if (
      previousToken.hasDuplicateAlternatives &&
      (quantifier.maxRepeat === null || quantifier.maxRepeat > MAX_DUPLICATE_ALTERNATIVE_REPEAT)
    ) {
      return "unsafe-ambiguous-alternation";
    }
    if (previousToken.hasAmbiguousAlternation && quantifier.maxRepeat === null) {
      return "unsafe-nested-repetition";
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

  return null;
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
  const unsafeReason = detectUnsafeRepetition(trimmed);
  if (unsafeReason) {
    result = { regex: null, source: trimmed, flags, reason: unsafeReason };
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
