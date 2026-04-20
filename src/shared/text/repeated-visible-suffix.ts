const STRUCTURED_REPEAT_HINT_RE = /[\s\d_\-~"'.,:;!?()[\]{}/\\]/;
const MIN_STRUCTURED_REPEAT_UNIT_LENGTH = 8;
const VISIBLE_SUFFIX_BOUNDARY_RE = /[.!?:;)\]}>`'"]$/;
const INTERNAL_PREAMBLE_HINT_RE =
  /\b(?:the user|instruction|output content|reply with|reply to|final response|general instruction|i will|i must|internal planning|plan:)\b/i;
const DELIMITER_LEAK_HARD_HINT_RE = /\binternal planning\b|(?:^|[\r\n])\s*plan:\s*$/i;
const DELIMITER_LEAK_LONG_HINT_RE =
  /\b(?:reply with|reply to|final response|output content|general instruction|i will|i must)\b/i;
const SINGLE_ANSWER_INTENT_RE =
  /\b(?:exactly|nothing else|one word(?: only)?|one short sentence(?: only)?|single answer)\b/i;
const INTENTIONAL_REPEAT_INTENT_RE =
  /\b(?:repeat|repeated|twice|\d+\s+times|three times|four times|five times)\b/i;
const EXACT_TARGET_HINT_RE =
  /\b(?:specific string|reply with|output the text directly|output content)\b/i;
const INLINE_CODE_LITERAL_RE = /`([^`\r\n]{1,400})`/g;
const DOUBLE_QUOTED_LITERAL_RE = /"([^"\r\n]{1,400})"/g;
const SINGLE_QUOTED_LITERAL_RE = /(?<![A-Za-z0-9_])'([^'\r\n]{1,400})'(?![A-Za-z0-9_])/g;
const EXCLUDED_TARGET_HINT_SEGMENT_RE = /\b(?:incorrect|wrong|duplicate|previous|attempt)\b/i;
const EXCLUDED_TRAILING_COLLAPSE_CONTEXT_RE =
  /\b(?:mistaken|example|examples|incorrect|wrong|previous attempt|doubled output|duplicate(?:d)? output)\b/i;
const MAX_STRUCTURED_SUFFIX_SCAN_CHARS = 8_192;
const MAX_DELIMITER_SUFFIX_SCAN_CHARS = 2_048;

type RepeatedPatternMatch = {
  unit: string;
  fullRepeats: number;
  tail: string;
};

function buildRawVisibleSuffix(match: RepeatedPatternMatch): string {
  return match.unit.repeat(match.fullRepeats) + match.tail;
}

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksStructuredRepeatedUnit(unit: string): boolean {
  return unit.length >= MIN_STRUCTURED_REPEAT_UNIT_LENGTH || STRUCTURED_REPEAT_HINT_RE.test(unit);
}

function endsAtVisibleSuffixBoundary(prefix: string): boolean {
  if (!prefix) {
    return true;
  }

  const trimmedPrefixEnd = prefix.trimEnd();
  if (!trimmedPrefixEnd) {
    return true;
  }

  return VISIBLE_SUFFIX_BOUNDARY_RE.test(trimmedPrefixEnd);
}

function looksLikeInternalPreamble(prefix: string): boolean {
  const trimmed = prefix.trim();
  if (trimmed.length < 120 || !INTERNAL_PREAMBLE_HINT_RE.test(trimmed)) {
    return false;
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const sentenceCount = (trimmed.match(/[.!?](?:\s|$)/g) ?? []).length;
  return lines.length >= 2 || sentenceCount >= 3;
}

function looksLikeDelimiterLeakPrefix(prefix: string): boolean {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return false;
  }

  if (DELIMITER_LEAK_HARD_HINT_RE.test(trimmed)) {
    return true;
  }

  return trimmed.length >= 120 && DELIMITER_LEAK_LONG_HINT_RE.test(trimmed);
}

function matchStructuredRepeatedPrefixPattern(text: string): RepeatedPatternMatch | null {
  if (!text) {
    return null;
  }

  for (let unitLength = 1; unitLength <= Math.floor(text.length / 2); unitLength += 1) {
    const unit = text.slice(0, unitLength);
    if (!looksStructuredRepeatedUnit(unit)) {
      continue;
    }

    let cursor = 0;
    let fullRepeats = 0;
    while (cursor + unitLength <= text.length && text.slice(cursor, cursor + unitLength) === unit) {
      cursor += unitLength;
      fullRepeats += 1;
    }
    if (fullRepeats < 2) {
      continue;
    }

    const tail = text.slice(cursor);
    if (!tail || unit.startsWith(tail)) {
      return { unit, fullRepeats, tail };
    }
  }

  return null;
}

function hasIntentionalRepeatRequest(prefix: string): boolean {
  return looksLikeInternalPreamble(prefix) && INTENTIONAL_REPEAT_INTENT_RE.test(prefix);
}

function shouldCollapseRepeatedSuffix(params: {
  prefix: string;
  match: RepeatedPatternMatch;
  context: "delimiter" | "no-delimiter";
}): boolean {
  const { prefix, match, context } = params;
  const hasRepeatIntent = hasIntentionalRepeatRequest(prefix);
  const hasSingleAnswerIntent =
    looksLikeInternalPreamble(prefix) && SINGLE_ANSWER_INTENT_RE.test(prefix);

  if (hasRepeatIntent) {
    return false;
  }

  if (match.tail.length > 0 || match.fullRepeats >= 3) {
    if (match.tail.length > 0) {
      return context === "delimiter"
        ? looksLikeDelimiterLeakPrefix(prefix)
        : looksLikeInternalPreamble(prefix);
    }
    return hasSingleAnswerIntent;
  }

  return hasSingleAnswerIntent;
}

function findExplicitVisibleSuffixTarget(
  prefix: string,
  match: RepeatedPatternMatch,
): string | null {
  if (!prefix || !looksLikeInternalPreamble(prefix)) {
    return null;
  }

  const explicitlyNamedLiteral = findExplicitSingleTargetLiteralInPreamble(prefix);
  if (!explicitlyNamedLiteral) {
    return null;
  }

  const rawVisibleSuffix = buildRawVisibleSuffix(match);
  if (rawVisibleSuffix.includes(explicitlyNamedLiteral)) {
    return explicitlyNamedLiteral;
  }

  return null;
}

function collapseExplicitStructuredRepeatTarget(params: {
  explicitTarget: string;
  match: RepeatedPatternMatch;
  prefix: string;
  context: "delimiter" | "no-delimiter";
}): string {
  const { explicitTarget, match, prefix, context } = params;
  if (context !== "no-delimiter" || hasIntentionalRepeatRequest(prefix)) {
    return explicitTarget;
  }
  if (match.tail.length === 0 && match.fullRepeats < 3) {
    return explicitTarget;
  }

  const nestedMatch = matchStructuredRepeatedPrefixPattern(explicitTarget);
  if (!nestedMatch || nestedMatch.tail.length > 0 || nestedMatch.fullRepeats < 2) {
    return explicitTarget;
  }
  if (nestedMatch.unit !== match.unit) {
    return explicitTarget;
  }

  return nestedMatch.unit;
}

function selectVisibleSuffixReplacement(params: {
  prefix: string;
  match: RepeatedPatternMatch;
  context: "delimiter" | "no-delimiter";
}): string | null {
  const { prefix, match, context } = params;

  if (hasIntentionalRepeatRequest(prefix)) {
    return null;
  }

  const explicitTarget = findExplicitVisibleSuffixTarget(prefix, match);
  if (explicitTarget) {
    if (context === "no-delimiter" && hasExcludedTrailingCollapseContext(prefix)) {
      return null;
    }
    return collapseExplicitStructuredRepeatTarget({ explicitTarget, match, prefix, context });
  }
  if (context === "delimiter" && findExplicitSingleTargetLiteralInPreamble(prefix)) {
    return null;
  }
  if (context === "no-delimiter" && hasExcludedTrailingCollapseContext(prefix)) {
    return null;
  }
  if (!shouldCollapseRepeatedSuffix({ prefix, match, context })) {
    return null;
  }

  return match.unit;
}

export function collapseRepeatedVisibleSuffixAfterDelimiter(
  prefix: string,
  suffix: string,
): string {
  const leadingWhitespace = suffix.match(/^\s*/)?.[0] ?? "";
  const normalizedSuffix = suffix.slice(leadingWhitespace.length);
  const scanSuffix =
    normalizedSuffix.length > MAX_DELIMITER_SUFFIX_SCAN_CHARS
      ? normalizedSuffix.slice(0, MAX_DELIMITER_SUFFIX_SCAN_CHARS)
      : normalizedSuffix;
  const match = matchStructuredRepeatedPrefixPattern(scanSuffix);
  if (!match) {
    return suffix;
  }

  const replacement = selectVisibleSuffixReplacement({ prefix, match, context: "delimiter" });
  return replacement ? `${leadingWhitespace}${replacement}` : suffix;
}

function splitPreambleHintSegments(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.match(/[^.!?]+[.!?]?/g) ?? [line])
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function extractTargetLiterals(text: string): string[] {
  return [
    ...text.matchAll(INLINE_CODE_LITERAL_RE),
    ...text.matchAll(DOUBLE_QUOTED_LITERAL_RE),
    ...text.matchAll(SINGLE_QUOTED_LITERAL_RE),
  ]
    .map((match) => match[1]?.trim() ?? "")
    .filter((literal) => literal.length > 0);
}

export function findExplicitSingleTargetLiteralInPreamble(text: string): string | null {
  if (
    !text ||
    !looksLikeInternalPreamble(text) ||
    !SINGLE_ANSWER_INTENT_RE.test(text) ||
    !EXACT_TARGET_HINT_RE.test(text)
  ) {
    return null;
  }

  const hintedSegments = splitPreambleHintSegments(text).filter(
    (segment) =>
      (SINGLE_ANSWER_INTENT_RE.test(segment) || EXACT_TARGET_HINT_RE.test(segment)) &&
      !EXCLUDED_TARGET_HINT_SEGMENT_RE.test(segment),
  );
  const hintedLiterals = hintedSegments.flatMap(extractTargetLiterals);
  const uniqueHintedLiterals = [...new Set(hintedLiterals)];
  if (uniqueHintedLiterals.length === 1) {
    return uniqueHintedLiterals[0] ?? null;
  }

  const uniqueLiterals = [...new Set(extractTargetLiterals(text))];
  if (uniqueLiterals.length !== 1) {
    return null;
  }

  return uniqueLiterals[0] ?? null;
}

function hasExcludedTrailingCollapseContext(prefix: string): boolean {
  const trailingSegment = splitPreambleHintSegments(prefix).at(-1) ?? "";
  return EXCLUDED_TRAILING_COLLAPSE_CONTEXT_RE.test(trailingSegment);
}

function extractExplicitRepeatedLiteralFromRunawayText(text: string): string | null {
  const literal = findExplicitSingleTargetLiteralInPreamble(text);
  if (!literal || !looksStructuredRepeatedUnit(literal)) {
    return null;
  }

  const runawaySuffixMatches = [
    ...text.matchAll(new RegExp(`(?:${escapeRegex(literal)}){3,}([^\\s][\\s\\S]*)$`, "g")),
  ];
  const runawaySuffixMatch = runawaySuffixMatches.at(-1);
  if (!runawaySuffixMatch) {
    return null;
  }
  const matchStart = runawaySuffixMatch.index ?? -1;
  if (matchStart < 0) {
    return null;
  }
  const prefix = text.slice(0, matchStart);
  if (!looksLikeInternalPreamble(prefix) || !endsAtVisibleSuffixBoundary(prefix)) {
    return null;
  }

  return collapseExplicitStructuredRepeatTarget({
    explicitTarget: literal,
    match: matchStructuredRepeatedPrefixPattern(literal) ?? {
      unit: literal,
      fullRepeats: 1,
      tail: "",
    },
    prefix,
    context: "no-delimiter",
  });
}

export function extractStructuredRepeatedVisibleSuffix(text: string): string {
  if (!text) {
    return text;
  }
  if (!looksLikeInternalPreamble(text)) {
    return text;
  }

  const scanText =
    text.length > MAX_STRUCTURED_SUFFIX_SCAN_CHARS
      ? text.slice(-MAX_STRUCTURED_SUFFIX_SCAN_CHARS)
      : text;
  const maxUnitLength = Math.floor(scanText.length / 2);
  for (let unitLength = 1; unitLength <= maxUnitLength; unitLength += 1) {
    for (let tailLength = 0; tailLength < unitLength; tailLength += 1) {
      const unitEnd = scanText.length - tailLength;
      const unitStart = unitEnd - unitLength;
      if (unitStart < 0) {
        continue;
      }

      const unit = scanText.slice(unitStart, unitEnd);
      if (!looksStructuredRepeatedUnit(unit)) {
        continue;
      }

      const tail = scanText.slice(unitEnd);
      if (tail && tail !== unit.slice(0, tail.length)) {
        continue;
      }

      let start = unitStart;
      let fullRepeats = 1;
      while (start - unitLength >= 0 && scanText.slice(start - unitLength, start) === unit) {
        start -= unitLength;
        fullRepeats += 1;
      }
      const prefix = scanText.slice(0, start);
      if (fullRepeats < 2 || !endsAtVisibleSuffixBoundary(prefix)) {
        continue;
      }

      const replacement = selectVisibleSuffixReplacement({
        prefix,
        match: { unit, fullRepeats, tail },
        context: "no-delimiter",
      });
      if (!replacement) {
        continue;
      }

      return replacement;
    }
  }

  return extractExplicitRepeatedLiteralFromRunawayText(text) ?? text;
}
