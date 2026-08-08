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
  containsAmbiguousAlternation: boolean;
  hasAlternation: boolean;
  hasOverlappingAlternative: boolean;
  alternativeSources: string[];
  branchStart: number;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
};

type PatternToken =
  | { kind: "simple-token" }
  | { kind: "group-open"; contentStart: number }
  | { kind: "group-close"; start: number }
  | { kind: "alternation"; start: number; end: number }
  | { kind: "quantifier"; quantifier: QuantifierRead };

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

function createParseFrame(branchStart = 0): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    containsAmbiguousAlternation: false,
    hasAlternation: false,
    hasOverlappingAlternative: false,
    alternativeSources: [],
    branchStart,
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

function readAlternativeLead(source: string): { broad: boolean; literal?: string } {
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "^" || ch === "$") {
      continue;
    }
    if (ch === "\\") {
      const escaped = source[index + 1];
      if (escaped === "b" || escaped === "B") {
        index += 1;
        continue;
      }
      if (escaped !== undefined && !/[0-9A-Za-z]/.test(escaped)) {
        return { broad: false, literal: escaped };
      }
      return { broad: true };
    }
    if (ch === "." || ch === "[" || ch === "(") {
      return { broad: true };
    }
    return { broad: false, literal: ch };
  }
  return { broad: true };
}

function alternativesMayOverlap(left: string, right: string, ignoreCase: boolean): boolean {
  const leftLead = readAlternativeLead(left);
  const rightLead = readAlternativeLead(right);
  if (leftLead.broad || rightLead.broad) {
    return true;
  }
  if (ignoreCase) {
    return leftLead.literal?.toLocaleLowerCase() === rightLead.literal?.toLocaleLowerCase();
  }
  return leftLead.literal === rightLead.literal;
}

function recordAlternative(
  frame: ParseFrame,
  source: string,
  branchEnd: number,
  ignoreCase: boolean,
): void {
  const branchSource = source.slice(frame.branchStart, branchEnd);
  if (
    frame.alternativeSources.some((alternative) =>
      alternativesMayOverlap(alternative, branchSource, ignoreCase),
    )
  ) {
    frame.hasOverlappingAlternative = true;
  }
  frame.alternativeSources.push(branchSource);
  if (frame.altMinLength === null || frame.altMaxLength === null) {
    frame.altMinLength = frame.branchMinLength;
    frame.altMaxLength = frame.branchMaxLength;
    return;
  }
  frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
  frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}

function readGroupContentStart(source: string, index: number): number {
  if (source[index + 1] !== "?") {
    return index + 1;
  }
  const marker = source[index + 2];
  if (marker === ":" || marker === "=" || marker === "!") {
    return index + 3;
  }
  if (marker !== "<") {
    return index + 1;
  }
  if (source[index + 3] === "=" || source[index + 3] === "!") {
    return index + 4;
  }
  const nameEnd = source.indexOf(">", index + 3);
  return nameEnd === -1 ? index + 1 : nameEnd + 1;
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

function tokenizePattern(source: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let inCharClass = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (inCharClass) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === "]") {
        inCharClass = false;
      }
      continue;
    }

    if (ch === "\\") {
      i += 1;
      tokens.push({ kind: "simple-token" });
      continue;
    }

    if (ch === "[") {
      inCharClass = true;
      tokens.push({ kind: "simple-token" });
      continue;
    }

    if (ch === "(") {
      const contentStart = readGroupContentStart(source, i);
      tokens.push({ kind: "group-open", contentStart });
      i = contentStart - 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close", start: i });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation", start: i, end: i + 1 });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    tokens.push({ kind: "simple-token" });
  }

  return tokens;
}

function analyzeTokensForNestedRepetition(
  source: string,
  tokens: PatternToken[],
  ignoreCase: boolean,
): boolean {
  const frames: ParseFrame[] = [createParseFrame()];

  const emitToken = (token: TokenState) => {
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    if (token.hasAmbiguousAlternation) {
      frame.containsAmbiguousAlternation = true;
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

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      emitSimpleToken();
      continue;
    }

    if (token.kind === "group-open") {
      frames.push(createParseFrame(token.contentStart));
      continue;
    }

    if (token.kind === "group-close") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.hasAlternation) {
          recordAlternative(frame, source, token.start, ignoreCase);
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
            frame.containsAmbiguousAlternation ||
            (frame.hasAlternation &&
              (frame.hasOverlappingAlternative ||
                (frame.altMinLength !== null &&
                  frame.altMaxLength !== null &&
                  frame.altMinLength !== frame.altMaxLength))),
          minLength: groupMinLength,
          maxLength: groupMaxLength,
        });
      }
      continue;
    }

    if (token.kind === "alternation") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      recordAlternative(frame, source, token.start, ignoreCase);
      frame.branchStart = token.end;
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.lastToken = null;
      continue;
    }

    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    const previousToken = frame.lastToken;
    if (!previousToken) {
      continue;
    }
    if (previousToken.containsRepetition) {
      return true;
    }
    if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) {
      return true;
    }

    const previousMinLength = previousToken.minLength;
    const previousMaxLength = previousToken.maxLength;
    previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
    previousToken.maxLength =
      token.quantifier.maxRepeat === null
        ? Number.POSITIVE_INFINITY
        : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
    previousToken.containsRepetition = true;
    frame.containsRepetition = true;
    frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;

    const branchMaxBase =
      Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength)
        ? frame.branchMaxLength - previousMaxLength
        : Number.POSITIVE_INFINITY;
    frame.branchMaxLength = addLength(branchMaxBase, previousToken.maxLength);
  }

  return false;
}

function testRegexFromStart(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  return regex.test(value);
}

export function testRegexWithBoundedInput(
  regex: RegExp,
  input: string,
  maxWindow = SAFE_REGEX_TEST_WINDOW,
): boolean {
  if (maxWindow <= 0) {
    return false;
  }
  if (input.length <= maxWindow) {
    return testRegexFromStart(regex, input);
  }
  const head = input.slice(0, maxWindow);
  if (testRegexFromStart(regex, head)) {
    return true;
  }
  return testRegexFromStart(regex, input.slice(-maxWindow));
}

function hasUnsafeRepetition(source: string, flags: string): boolean {
  // Conservative parser: tokenize first, then check if repeated tokens/groups are repeated again.
  // Non-goal: complete regex AST support; keep strict enough for config safety checks.
  return analyzeTokensForNestedRepetition(source, tokenizePattern(source), flags.includes("i"));
}

export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  if (!source.trim()) {
    return { regex: null, source, flags, reason: "empty" };
  }
  const cacheKey = `${flags}::${source}`;
  if (safeRegexCache.has(cacheKey)) {
    return (
      safeRegexCache.get(cacheKey) ?? {
        regex: null,
        source,
        flags,
        reason: "invalid-regex",
      }
    );
  }

  let result: SafeRegexCompileResult;
  if (hasUnsafeRepetition(source, flags)) {
    result = { regex: null, source, flags, reason: "unsafe-nested-repetition" };
  } else {
    try {
      result = { regex: new RegExp(source, flags), source, flags, reason: null };
    } catch {
      result = { regex: null, source, flags, reason: "invalid-regex" };
    }
  }

  safeRegexCache.set(cacheKey, result);
  pruneMapToMaxSize(safeRegexCache, SAFE_REGEX_CACHE_MAX);
  return result;
}

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}
