// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  alternativeSequencesOverlap,
  atomsCanMatchSamePrefix,
  classHasUnknownConsumedLength,
  isUnicodeRegexMode,
  readCompleteEscapeAtom,
  sequenceHasUnknownLength,
  UNKNOWN_LENGTH_ATOM,
} from "./safe-regex-atoms.js";
import {
  escapeHasUnknownConsumedLength,
  isUnicodeSetsMode,
  isZeroWidthAssertionEscape,
  isZeroWidthAssertionToken,
  readCharClassSig,
  readLiteralCodePoint,
} from "./safe-regex-numeric.js";

type QuantifierRead = {
  consumed: number;
  minRepeat: number;
  maxRepeat: number | null;
};

type TokenState = {
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  hasAssertion: boolean;
  minLength: number;
  maxLength: number;
  sequences: string[][];
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  hasAlternation: boolean;
  assertion: boolean;
  hasAssertion: boolean;
  modifierUnknown: boolean;
  branchMinLength: number;
  branchMaxLength: number;
  altMinLength: number | null;
  altMaxLength: number | null;
  branchSequences: string[][];
  altSequences: string[][];
};

type PatternToken =
  | { kind: "simple-token"; sig: string }
  | { kind: "group-open"; assertion: boolean; modifierUnknown: boolean }
  | { kind: "group-close" }
  | { kind: "alternation" }
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

function createParseFrame(): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    hasAlternation: false,
    assertion: false,
    hasAssertion: false,
    modifierUnknown: false,
    branchMinLength: 0,
    branchMaxLength: 0,
    altMinLength: null,
    altMaxLength: null,
    branchSequences: [],
    altSequences: [],
  };
}

const MAX_TOKEN_SEQUENCE_SET = 32;

function unknownLengthSequences(): string[][] {
  return [[UNKNOWN_LENGTH_ATOM]];
}

function sequencesHaveUnknownLength(sequences: readonly (readonly string[])[]): boolean {
  return sequences.some((seq) => sequenceHasUnknownLength(seq));
}

function concatTokenSequences(left: string[][], right: string[][]): string[][] {
  if (right.length === 0) {
    return left;
  }
  if (left.length === 0) {
    // Bound atoms per sequence. The 32-set cap does not bound one long literal.
    return right.map((seq) => seq.slice(0, MAX_TOKEN_SEQUENCE_SET));
  }
  if (left.every((seq) => seq.length >= MAX_TOKEN_SEQUENCE_SET)) {
    return left;
  }
  if (sequencesHaveUnknownLength(left) || sequencesHaveUnknownLength(right)) {
    return unknownLengthSequences();
  }
  const out: string[][] = [];
  for (const prefix of left) {
    for (const suffix of right) {
      const room = MAX_TOKEN_SEQUENCE_SET - prefix.length;
      out.push(room <= 0 ? prefix : [...prefix, ...suffix.slice(0, room)]);
      if (out.length > MAX_TOKEN_SEQUENCE_SET) {
        return unknownLengthSequences();
      }
    }
  }
  return out;
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
  if (frame.branchSequences.length === 0) {
    frame.altSequences.push([]);
  } else {
    frame.altSequences.push(...frame.branchSequences);
  }
  if (
    frame.altSequences.length > MAX_TOKEN_SEQUENCE_SET ||
    sequencesHaveUnknownLength(frame.altSequences)
  ) {
    frame.altSequences = unknownLengthSequences();
  }
  frame.branchSequences = [];
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

function consumeGroupPrefix(
  source: string,
  openIndex: number,
): { nextIndex: number; unknown: boolean; assertion: boolean; modifierUnknown: boolean } {
  const question = openIndex + 1;
  if (source[question] !== "?") {
    return { nextIndex: openIndex + 1, unknown: false, assertion: false, modifierUnknown: false };
  }
  const after = source[question + 1];
  if (after === ":") {
    return { nextIndex: question + 2, unknown: false, assertion: false, modifierUnknown: false };
  }
  if (after === "=" || after === "!") {
    return { nextIndex: question + 2, unknown: false, assertion: true, modifierUnknown: false };
  }
  if (after === "<") {
    const look = source[question + 2];
    if (look === "=" || look === "!") {
      return { nextIndex: question + 3, unknown: false, assertion: true, modifierUnknown: false };
    }
    const nameEnd = source.indexOf(">", question + 2);
    if (nameEnd !== -1) {
      return { nextIndex: nameEnd + 1, unknown: false, assertion: false, modifierUnknown: false };
    }
    return { nextIndex: question + 1, unknown: true, assertion: false, modifierUnknown: false };
  }
  let i = question + 1;
  while (i < source.length && /[a-zA-Z-]/.test(source[i] ?? "")) {
    i += 1;
  }
  if (source[i] === ":") {
    return { nextIndex: i + 1, unknown: false, assertion: false, modifierUnknown: true };
  }
  return { nextIndex: question + 1, unknown: true, assertion: false, modifierUnknown: true };
}

function tokenizePattern(
  source: string,
  unicode = false,
  capturingGroups = 0,
  unicodeSets = false,
): PatternToken[] {
  const tokens: PatternToken[] = [];

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];

    if (ch === "\\") {
      const atom = readCompleteEscapeAtom(source, i, { unicode, capturingGroups });
      tokens.push({ kind: "simple-token", sig: atom.sig });
      i = atom.end - 1;
      continue;
    }

    if (ch === "[") {
      const atom = readCharClassSig(source, i, unicodeSets);
      tokens.push({ kind: "simple-token", sig: atom.sig });
      i = atom.end - 1;
      continue;
    }

    if (ch === "(") {
      const prefix = consumeGroupPrefix(source, i);
      tokens.push({
        kind: "group-open",
        assertion: prefix.assertion,
        modifierUnknown: prefix.modifierUnknown,
      });
      if (prefix.unknown) {
        tokens.push({ kind: "simple-token", sig: "." });
      }
      i = prefix.nextIndex - 1;
      continue;
    }

    if (ch === ")") {
      tokens.push({ kind: "group-close" });
      continue;
    }

    if (ch === "|") {
      tokens.push({ kind: "alternation" });
      continue;
    }

    const quantifier = readQuantifier(source, i);
    if (quantifier) {
      tokens.push({ kind: "quantifier", quantifier });
      i += quantifier.consumed - 1;
      continue;
    }

    const literal = readLiteralCodePoint(source, i, unicode);
    tokens.push({ kind: "simple-token", sig: literal.sig });
    i = literal.end - 1;
  }

  return tokens;
}

function analyzeTokensForNestedRepetition(
  tokens: PatternToken[],
  distinguishDisjointAlternatives = false,
  foldCase = false,
  unicode = false,
  capturingGroups = 0,
  unicodeSets = false,
): boolean {
  const frames: ParseFrame[] = [createParseFrame()];

  const emitToken = (token: TokenState) => {
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    frame.lastToken = token;
    if (token.containsRepetition) {
      frame.containsRepetition = true;
    }
    if (token.hasAssertion) {
      frame.hasAssertion = true;
    }
    if (token.sequences.length > 0) {
      frame.branchSequences = concatTokenSequences(frame.branchSequences, token.sequences);
    }
    frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
    frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
  };

  const emitSimpleToken = (sig: string) => {
    if (
      escapeHasUnknownConsumedLength(sig, { unicode, capturingGroups, unicodeSets }) ||
      classHasUnknownConsumedLength(sig, unicodeSets)
    ) {
      emitToken({
        containsRepetition: false,
        hasAmbiguousAlternation: false,
        hasAssertion: false,
        minLength: 0,
        maxLength: Number.POSITIVE_INFINITY,
        sequences: unknownLengthSequences(),
      });
      return;
    }
    if (isZeroWidthAssertionToken(sig)) {
      emitToken({
        containsRepetition: false,
        hasAmbiguousAlternation: false,
        hasAssertion: true,
        minLength: 0,
        maxLength: 0,
        sequences: [],
      });
      return;
    }
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: false,
      hasAssertion: false,
      minLength: 1,
      maxLength: 1,
      sequences: [[sig]],
    });
  };

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      emitSimpleToken(token.sig);
      continue;
    }

    if (token.kind === "group-open") {
      const frame = createParseFrame();
      frame.assertion = token.assertion;
      frame.modifierUnknown = token.modifierUnknown;
      frames.push(frame);
      continue;
    }

    if (token.kind === "group-close") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        if (frame.assertion) {
          emitToken({
            containsRepetition: frame.containsRepetition,
            hasAmbiguousAlternation: false,
            hasAssertion: true,
            minLength: 0,
            maxLength: 0,
            sequences: [],
          });
          continue;
        }
        if (frame.hasAlternation) {
          recordAlternative(frame);
        }
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        const lengthAmbiguous =
          frame.hasAlternation &&
          frame.altMinLength !== null &&
          frame.altMaxLength !== null &&
          frame.altMinLength !== frame.altMaxLength;
        const groupSequences = frame.modifierUnknown
          ? unknownLengthSequences()
          : frame.hasAlternation
            ? frame.altSequences
            : frame.branchSequences;
        const overlapping =
          sequencesHaveUnknownLength(groupSequences) ||
          alternativeSequencesOverlap(groupSequences, foldCase, unicode, capturingGroups);
        emitToken({
          containsRepetition: frame.containsRepetition,
          hasAmbiguousAlternation: distinguishDisjointAlternatives
            ? overlapping && (lengthAmbiguous || frame.hasAssertion)
            : lengthAmbiguous,
          hasAssertion: frame.hasAssertion,
          minLength: groupMinLength,
          maxLength: groupMaxLength,
          sequences: groupSequences.length > 0 ? groupSequences : [[""]],
        });
      }
      continue;
    }

    if (token.kind === "alternation") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      recordAlternative(frame);
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

function countCapturingGroups(source: string): number {
  let count = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") {
      i = readCharClassSig(source, i).end - 1;
      continue;
    }
    if (ch !== "(") {
      continue;
    }
    const prefix = consumeGroupPrefix(source, i);
    if (!prefix.assertion && !prefix.unknown) {
      const head = source.slice(i, Math.min(prefix.nextIndex, i + 3));
      if (head === "(" || head.startsWith("(?<")) {
        count += 1;
      }
    }
    i = prefix.nextIndex - 1;
  }
  return count;
}

function hasNestedRepetition(
  source: string,
  options?: { distinguishDisjointAlternatives?: boolean; flags?: string },
): boolean {
  // Conservative parser: tokenize first, then check if repeated tokens/groups are repeated again.
  // Non-goal: complete regex AST support; keep strict enough for config safety checks.
  const flags = options?.flags ?? "";
  const unicode = isUnicodeRegexMode(flags);
  const unicodeSets = isUnicodeSetsMode(flags);
  const capturingGroups = countCapturingGroups(source);
  return analyzeTokensForNestedRepetition(
    tokenizePattern(source, unicode, capturingGroups, unicodeSets),
    options?.distinguishDisjointAlternatives === true,
    flags.includes("i"),
    unicode,
    capturingGroups,
    unicodeSets,
  );
}

export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }
  const cacheKey = `${flags}::${trimmed}`;
  if (safeRegexCache.has(cacheKey)) {
    return (
      safeRegexCache.get(cacheKey) ?? {
        regex: null,
        source: trimmed,
        flags,
        reason: "invalid-regex",
      }
    );
  }

  let result: SafeRegexCompileResult;
  if (hasNestedRepetition(trimmed, { distinguishDisjointAlternatives: true, flags })) {
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

function readGroupAtom(
  source: string,
  index: number,
  unicodeSets = false,
): { end: number; sig: string; zeroWidth: boolean } {
  const prefix = source.slice(index, index + 4);
  const zeroWidth =
    prefix.startsWith("(?=") ||
    prefix.startsWith("(?!") ||
    prefix.startsWith("(?<=") ||
    prefix.startsWith("(?<!");
  let depth = 1;
  let i = index + 1;
  while (i < source.length && depth > 0) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "[") {
      i = readCharClassSig(source, i, unicodeSets).end;
      continue;
    }
    if (source[i] === "(") {
      depth += 1;
    } else if (source[i] === ")") {
      depth -= 1;
    }
    i += 1;
  }
  return { end: i, sig: source.slice(index, i), zeroWidth };
}

function hasAdjacentUnboundedTwins(source: string, flags = ""): boolean {
  let pending: string | null = null;
  let i = 0;
  const foldCase = flags.includes("i");
  const unicode = isUnicodeRegexMode(flags);
  const unicodeSets = isUnicodeSetsMode(flags);
  const capturingGroups = countCapturingGroups(source);

  while (i < source.length) {
    const ch = source[i];
    if (ch === "^" || ch === "$") {
      i += 1;
      continue;
    }
    if (ch === "|" || ch === ")") {
      pending = null;
      i += 1;
      continue;
    }

    let end: number;
    let sig: string;
    let zeroWidth = false;
    if (ch === "\\") {
      const atom = readCompleteEscapeAtom(source, i, { unicode, capturingGroups });
      end = atom.end;
      sig = atom.sig;
      zeroWidth = isZeroWidthAssertionEscape(sig);
    } else if (ch === "[") {
      const atom = readCharClassSig(source, i, unicodeSets);
      end = atom.end;
      sig = atom.sig;
    } else if (ch === "(") {
      const atom = readGroupAtom(source, i, unicodeSets);
      end = atom.end;
      sig = atom.sig;
      zeroWidth = atom.zeroWidth;
    } else {
      const literal = readLiteralCodePoint(source, i, unicode);
      end = literal.end;
      sig = literal.sig;
    }

    i = end;
    const quantifier = readQuantifier(source, i);
    let unbounded = false;
    if (quantifier) {
      i += quantifier.consumed;
      unbounded = quantifier.maxRepeat === null;
    }

    if (unbounded) {
      if (!zeroWidth) {
        if (
          pending !== null &&
          atomsCanMatchSamePrefix(pending, sig, foldCase, unicode, capturingGroups)
        ) {
          return true;
        }
        pending = sig;
      }
      continue;
    }
    if (!zeroWidth) {
      pending = null;
    }
  }
  return false;
}

export function compileJsonSchemaPatternRegex(source: string, flags = ""): RegExp | null {
  return compileJsonSchemaPatternRegexDetailed(source, flags).regex;
}

/** Exact-source compile for JSON Schema patternProperties (do not trim). */
export function compileJsonSchemaPatternRegexDetailed(
  source: string,
  flags = "",
): SafeRegexCompileResult {
  const cacheKey = `schema::${flags}::${source}`;
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
  if (
    hasNestedRepetition(source, { distinguishDisjointAlternatives: true, flags }) ||
    hasAdjacentUnboundedTwins(source, flags)
  ) {
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
