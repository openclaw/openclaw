// Performs lightweight safe-regex checks for user-supplied patterns.
import { expectDefined } from "@openclaw/normalization-core";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import {
  isLookaroundPrefix,
  isZeroWidthLanguage,
  mixedSequencesOverlap,
  nextPendingAdjacentAlts,
  shouldRejectAdjacentOverlap,
  singleTokenAlternativesMayOverlap,
} from "./safe-regex-adjacent.js";
import {
  alternativeSourcesHavePrefixOverlap,
  fixedWidthLiteralAlternativesAreDisjoint,
} from "./safe-regex-sequences.js";
import {
  ATOM_SEQUENCE_OVERFLOW,
  countCapturingGroups,
  readAlternativeAtomSequences,
  readEscapeAtomEnd,
  readScalarEscape,
  sequenceAtomsForOverlap,
  sequenceOverlapIsProven,
  tokenizePattern,
  type PatternToken,
} from "./safe-regex-tokens.js";

type TokenState = {
  containsRepetition: boolean;
  hasAmbiguousAlternation: boolean;
  minLength: number;
  maxLength: number;
  language: string | null;
  alternatives: string[];
};

type ParseFrame = {
  lastToken: TokenState | null;
  containsRepetition: boolean;
  containsAmbiguousAlternation: boolean;
  hasAlternation: boolean;
  hasOverlappingAlternative: boolean;
  alternativeSources: string[];
  contentStart: number;
  branchStart: number;
  branchMinLength: number;
  branchMaxLength: number;
  branchTokenCount: number;
  altMinLength: number | null;
  altMaxLength: number | null;
  // Previous unbounded quantified atom, used to catch a*a* adjacent twins.
  // Stored as complete alternative unions so (a|b)*(b|c)* is compared as
  // {a,b} vs {b,c}, not only the last branch after `|`.
  pendingAdjacentAlts: string[] | null;
  pendingNextAlts: string[] | null;
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

function createParseFrame(contentStart = 0): ParseFrame {
  return {
    lastToken: null,
    containsRepetition: false,
    containsAmbiguousAlternation: false,
    hasAlternation: false,
    hasOverlappingAlternative: false,
    alternativeSources: [],
    contentStart,
    branchStart: contentStart,
    branchMinLength: 0,
    branchMaxLength: 0,
    branchTokenCount: 0,
    altMinLength: null,
    altMaxLength: null,
    pendingAdjacentAlts: null,
    pendingNextAlts: null,
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

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readAlternativeLiteral(
  source: string,
  unicodeMode = false,
  captureCount = 0,
): { kind: "broad" } | { kind: "literal"; value: string } {
  let value = "";
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "^" || ch === "$") {
      continue;
    }
    if (ch === "\\") {
      const scalar = readScalarEscape(source, index, unicodeMode, captureCount);
      if (scalar) {
        value += scalar.value;
        index = scalar.nextIndex - 1;
        continue;
      }
      const escaped = source[index + 1];
      if (escaped === "b" || escaped === "B") {
        index += 1;
        continue;
      }
      if (escaped !== undefined && !/[0-9A-Za-z]/.test(escaped)) {
        value += escaped;
        index += 1;
        continue;
      }
      return { kind: "broad" };
    }
    if (
      ch === "." ||
      ch === "[" ||
      ch === "(" ||
      ch === ")" ||
      ch === "|" ||
      ch === "*" ||
      ch === "+" ||
      ch === "?" ||
      ch === "{"
    ) {
      return { kind: "broad" };
    }
    value += ch;
  }
  return value.length === 0 ? { kind: "broad" } : { kind: "literal", value };
}

function isSingleTokenAlternative(source: string, unicodeMode = false, captureCount = 0): boolean {
  // True for one char, one escape, or one char-class after anchors.
  // Used so unions like ([\w]|[-.])+ are not treated as nested ReDoS.
  let tokens = 0;
  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "^" || ch === "$") {
      continue;
    }
    if (ch === "\\") {
      tokens += 1;
      index = readEscapeAtomEnd(source, index, unicodeMode, captureCount);
      if (tokens > 1) {
        return false;
      }
      continue;
    }
    if (ch === "[") {
      tokens += 1;
      if (tokens > 1) {
        return false;
      }
      let depth = 1;
      index += 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "[") {
          depth += 1;
        } else if (source[index] === "]") {
          depth -= 1;
        }
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (
      ch === "(" ||
      ch === ")" ||
      ch === "|" ||
      ch === "*" ||
      ch === "+" ||
      ch === "?" ||
      ch === "{" ||
      ch === "."
    ) {
      return false;
    }
    tokens += 1;
    if (tokens > 1) {
      return false;
    }
  }
  return tokens === 1;
}

function alternativesMayOverlap(
  left: string,
  right: string,
  ignoreCase: boolean,
  failClosedUnprobedUnicode: boolean,
  unicodeMode = false,
  captureCount = 0,
  dotAll = false,
): boolean {
  const leftLit = readAlternativeLiteral(left, unicodeMode, captureCount);
  const rightLit = readAlternativeLiteral(right, unicodeMode, captureCount);
  if (leftLit.kind === "literal" && rightLit.kind === "literal") {
    const a = leftLit.value;
    const b = rightLit.value;
    if (!ignoreCase) {
      // Equal or prefix (a vs aa) can both match unbounded repeats of the group.
      return a === b || a.startsWith(b) || b.startsWith(a);
    }
    // JS ignore-case matching is not String#toLowerCase (e.g. Σ vs ς).
    // Use RegExp /iu so case equivalence matches the authorization engine.
    try {
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      return new RegExp(`^${escapeRegExpLiteral(shorter)}`, "iu").test(longer);
    } catch {
      return true;
    }
  }
  // Single-token unions (class/escape/literal) are safe only when proven
  // disjoint. Overlapping classes like \w|\d still admit unbounded ambiguity.
  if (
    isSingleTokenAlternative(left, unicodeMode, captureCount) &&
    isSingleTokenAlternative(right, unicodeMode, captureCount)
  ) {
    return singleTokenAlternativesMayOverlap(
      left,
      right,
      ignoreCase,
      failClosedUnprobedUnicode,
      unicodeMode,
      dotAll,
    );
  }
  const leftSequences = readAlternativeAtomSequences(left, unicodeMode, captureCount);
  const rightSequences = readAlternativeAtomSequences(right, unicodeMode, captureCount);
  // Budget exhaustion is not proven overlap. A same-width literal code such
  // as (aa|bb|...|qq)|zz stays accepted, including under i when ASCII
  // case-folding still leaves every literal unique. A fold collision or a
  // non-ASCII literal stays refused. Unproven overflow still refuses.
  if (leftSequences === ATOM_SEQUENCE_OVERFLOW || rightSequences === ATOM_SEQUENCE_OVERFLOW) {
    if (fixedWidthLiteralAlternativesAreDisjoint(left, right, ignoreCase)) {
      return false;
    }
    return true;
  }
  if (leftSequences && rightSequences) {
    // Nested groups such as (ab|cd)e expand to finite sequences. Unequal
    // lengths stay safe when a shared prefix atom is disjoint.
    let unproven = false;
    for (const leftSeq of leftSequences) {
      for (const rightSeq of rightSequences) {
        if (
          !mixedSequencesOverlap(
            sequenceAtomsForOverlap(leftSeq),
            sequenceAtomsForOverlap(rightSeq),
            ignoreCase,
            failClosedUnprobedUnicode,
            (leftAtom, rightAtom, ignoreCaseFlag, failClosed) =>
              singleTokenAlternativesMayOverlap(
                leftAtom,
                rightAtom,
                ignoreCaseFlag,
                failClosed,
                unicodeMode,
                dotAll,
              ),
          )
        ) {
          continue;
        }
        if (sequenceOverlapIsProven(leftSeq, rightSeq)) {
          return true;
        }
        if (alternativeSourcesHavePrefixOverlap(left, right)) {
          return true;
        }
        if (leftSeq.unknownTail === true && rightSeq.unknownTail === true) {
          // Both omitted tails are more copies of the atom already compared.
          // 34 versus 68 of the same atom overlaps. A later distinct suffix
          // is not homogeneous and stays unproven on the shared compiler.
          if (leftSeq.unknownTailHomogeneous === true && rightSeq.unknownTailHomogeneous === true) {
            return true;
          }
          unproven = true;
          continue;
        }
        unproven = true;
      }
    }
    // Remaining unproven cases stay fail-closed only on the exec path.
    return unproven && failClosedUnprobedUnicode;
  }
  // Mixed structure with broad components (e.g. aa|a.) can overlap under +.
  return true;
}

function recordAlternative(
  frame: ParseFrame,
  source: string,
  branchEnd: number,
  ignoreCase: boolean,
  failClosedUnprobedUnicode: boolean,
  unicodeMode: boolean,
  captureCount: number,
  dotAll: boolean,
): void {
  const branchSource = source.slice(frame.branchStart, branchEnd);
  if (
    frame.alternativeSources.some((alternative) =>
      alternativesMayOverlap(
        alternative,
        branchSource,
        ignoreCase,
        failClosedUnprobedUnicode,
        unicodeMode,
        captureCount,
        dotAll,
      ),
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

/** Adjacent twins: equal signatures, or proven single-token overlap. No Unicode fail-closed. */
function adjacentPairOverlaps(
  left: string,
  right: string,
  ignoreCase: boolean,
  unicodeMode = false,
  captureCount = 0,
  dotAll = false,
): boolean {
  return (
    isSingleTokenAlternative(left, unicodeMode, captureCount) &&
    isSingleTokenAlternative(right, unicodeMode, captureCount) &&
    alternativesMayOverlap(left, right, ignoreCase, false, unicodeMode, captureCount, dotAll)
  );
}

function analyzeTokensForNestedRepetition(
  source: string,
  tokens: PatternToken[],
  ignoreCase: boolean,
  failClosedUnprobedUnicode: boolean,
  unicodeMode: boolean,
  captureCount: number,
  dotAll: boolean,
): boolean {
  const pairOverlaps = (left: string, right: string, ignoreCaseFlag: boolean) =>
    adjacentPairOverlaps(left, right, ignoreCaseFlag, unicodeMode, captureCount, dotAll);
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
    frame.branchTokenCount += 1;
  };

  const noteAdjacentAtom = (language: string, alternatives: string[], minLength = 1) => {
    if (minLength === 0 || isZeroWidthLanguage(language, alternatives)) {
      return;
    }
    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    if (frame.pendingNextAlts !== null) {
      // A second unquantified atom sits between repeats, so they are not adjacent.
      frame.pendingAdjacentAlts = null;
      frame.pendingNextAlts = null;
    } else if (frame.pendingAdjacentAlts !== null) {
      frame.pendingNextAlts = alternatives;
    }
  };

  const emitSimpleToken = (language: string) => {
    const alternatives = [language];
    noteAdjacentAtom(language, alternatives);
    emitToken({
      containsRepetition: false,
      hasAmbiguousAlternation: false,
      minLength: 1,
      maxLength: 1,
      language,
      alternatives,
    });
  };

  for (const token of tokens) {
    if (token.kind === "simple-token") {
      emitSimpleToken(token.source);
      continue;
    }

    if (token.kind === "group-open") {
      frames.push(createParseFrame(token.contentStart));
      continue;
    }

    if (token.kind === "group-close") {
      if (frames.length > 1) {
        const frame = frames.pop() as ParseFrame;
        const parent = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
        if (isLookaroundPrefix(source, frame.contentStart)) {
          noteAdjacentAtom("(?=)", ["(?=)"]);
          emitToken({
            containsRepetition: false,
            hasAmbiguousAlternation: false,
            minLength: 0,
            maxLength: 0,
            language: "(?=)",
            alternatives: ["(?=)"],
          });
          continue;
        }
        if (frame.hasAlternation) {
          recordAlternative(
            frame,
            source,
            token.start,
            ignoreCase,
            failClosedUnprobedUnicode,
            unicodeMode,
            captureCount,
            dotAll,
          );
        }
        const groupMinLength = frame.hasAlternation
          ? (frame.altMinLength ?? 0)
          : frame.branchMinLength;
        const groupMaxLength = frame.hasAlternation
          ? (frame.altMaxLength ?? 0)
          : frame.branchMaxLength;
        const groupLanguage =
          (frame.hasAlternation
            ? frame.alternativeSources.join("|")
            : source.slice(frame.contentStart, token.start)) || "(?:)";
        const groupAlts =
          frame.hasAlternation && frame.alternativeSources.length > 0
            ? frame.alternativeSources
            : frame.branchTokenCount === 1 &&
                frame.lastToken?.alternatives &&
                frame.lastToken.alternatives.length > 0
              ? frame.lastToken.alternatives
              : [groupLanguage];
        const groupUnbounded = !Number.isFinite(groupMaxLength);
        if (
          groupUnbounded &&
          parent.pendingAdjacentAlts &&
          parent.pendingNextAlts === null &&
          shouldRejectAdjacentOverlap(
            parent.pendingAdjacentAlts,
            groupAlts,
            ignoreCase,
            failClosedUnprobedUnicode,
            pairOverlaps,
          )
        ) {
          return true;
        }
        noteAdjacentAtom(groupLanguage, groupAlts, groupMinLength);
        emitToken({
          containsRepetition: frame.containsRepetition,
          // Only mark ambiguous when alternatives may actually overlap.
          // Disjoint unequal lengths such as (a|bc)+ are safe and must remain
          // accepted (compatibility with main; Claw P1 on schema ReDoS guards).
          hasAmbiguousAlternation:
            frame.containsAmbiguousAlternation ||
            (frame.hasAlternation && frame.hasOverlappingAlternative),
          minLength: groupMinLength,
          maxLength: groupMaxLength,
          language: groupLanguage,
          alternatives: groupAlts,
        });
        if (groupUnbounded && !isZeroWidthLanguage(groupLanguage, groupAlts)) {
          parent.pendingAdjacentAlts = nextPendingAdjacentAlts(
            parent.pendingAdjacentAlts,
            groupAlts,
            groupMinLength === 0 ? 0 : 1,
            null,
            false,
          );
          parent.pendingNextAlts = null;
        }
      }
      continue;
    }

    if (token.kind === "alternation") {
      const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
      frame.hasAlternation = true;
      recordAlternative(
        frame,
        source,
        token.start,
        ignoreCase,
        failClosedUnprobedUnicode,
        unicodeMode,
        captureCount,
        dotAll,
      );
      frame.branchStart = token.end;
      frame.branchMinLength = 0;
      frame.branchMaxLength = 0;
      frame.branchTokenCount = 0;
      frame.lastToken = null;
      frame.pendingAdjacentAlts = null;
      frame.pendingNextAlts = null;
      continue;
    }

    const frame = expectDefined(frames[frames.length - 1], "frames entry at frames.length 1");
    const previousToken = frame.lastToken;
    if (!previousToken) {
      continue;
    }
    if (
      frame.pendingAdjacentAlts &&
      frame.pendingNextAlts &&
      token.quantifier.maxRepeat === null &&
      shouldRejectAdjacentOverlap(
        frame.pendingAdjacentAlts,
        frame.pendingNextAlts,
        ignoreCase,
        failClosedUnprobedUnicode,
        pairOverlaps,
      )
    ) {
      return true;
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
    const previousLanguage = previousToken.language ?? "";
    frame.pendingAdjacentAlts = nextPendingAdjacentAlts(
      frame.pendingAdjacentAlts,
      previousToken.alternatives,
      token.quantifier.minRepeat,
      token.quantifier.maxRepeat,
      isZeroWidthLanguage(previousLanguage, previousToken.alternatives),
    );
    frame.pendingNextAlts = null;
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

function hasUnsafeRepetition(
  source: string,
  flags: string,
  failClosedUnprobedUnicode: boolean,
): boolean {
  // Conservative parser: tokenize first, then check if repeated tokens/groups are repeated again.
  // Non-goal: complete regex AST support; keep strict enough for config safety checks.
  const unicodeMode = flags.includes("u") || flags.includes("v");
  const tokens = tokenizePattern(source, flags);
  return analyzeTokensForNestedRepetition(
    source,
    tokens,
    flags.includes("i"),
    failClosedUnprobedUnicode,
    unicodeMode,
    countCapturingGroups(source, tokens),
    flags.includes("s"),
  );
}

function compileSafeRegexDetailedImpl(
  source: string,
  flags: string,
  failClosedUnprobedUnicode: boolean,
): SafeRegexCompileResult {
  // Shared contract: trim nonblank source for every caller (plugins/config/cron/SDK).
  // Exec approvals that need raw source handle that on the exec path only.
  const trimmed = source.trim();
  if (!trimmed) {
    return { regex: null, source: trimmed, flags, reason: "empty" };
  }
  const cacheKey = `${failClosedUnprobedUnicode ? "exec" : "shared"}::${flags}::${trimmed}`;
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
  if (hasUnsafeRepetition(trimmed, flags, failClosedUnprobedUnicode)) {
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

export function compileSafeRegexDetailed(source: string, flags = ""): SafeRegexCompileResult {
  return compileSafeRegexDetailedImpl(source, flags, false);
}

/**
 * Exec-only compiler. Unprobed Unicode single-token alts fail closed.
 * Not part of the public plugin SDK (shared compileSafeRegexDetailed stays two-arg).
 */
export function compileSafeRegexForExec(source: string, flags = ""): SafeRegexCompileResult {
  return compileSafeRegexDetailedImpl(source, flags, true);
}

export function compileSafeRegex(source: string, flags = ""): RegExp | null {
  return compileSafeRegexDetailed(source, flags).regex;
}
