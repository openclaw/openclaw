const STRUCTURED_REPEAT_HINT_RE = /[\s\d_\-~"'.,:;!?()[\]{}/\\]/;
const MIN_STRUCTURED_REPEAT_UNIT_LENGTH = 8;
const VISIBLE_SUFFIX_BOUNDARY_RE = /[.!?:;)\]}>`'"]$/;
const INTERNAL_PREAMBLE_HINT_RE =
  /\b(?:the user|instruction|output content|reply with|reply to|final response|general instruction|i will|i must|internal planning|plan:)\b/i;
const SINGLE_ANSWER_INTENT_RE =
  /\b(?:exactly|nothing else|one word(?: only)?|one short sentence(?: only)?|single answer)\b/i;
const EXACT_TARGET_HINT_RE =
  /\b(?:specific string|reply with|output the text directly|output content)\b/i;
const INLINE_CODE_LITERAL_RE = /`([^`\r\n]{1,400})`/g;

type RepeatedPatternMatch = {
  unit: string;
  fullRepeats: number;
  tail: string;
};

function buildRawVisibleSuffix(match: RepeatedPatternMatch): string {
  return match.unit.repeat(match.fullRepeats) + match.tail;
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

function shouldCollapseRepeatedSuffix(params: {
  prefix: string;
  match: RepeatedPatternMatch;
  context: "delimiter" | "no-delimiter";
}): boolean {
  const { prefix, match, context } = params;

  if (match.tail.length > 0 || match.fullRepeats >= 3) {
    return context === "delimiter" || looksLikeInternalPreamble(prefix);
  }

  return looksLikeInternalPreamble(prefix) && SINGLE_ANSWER_INTENT_RE.test(prefix);
}

function findExplicitVisibleSuffixTarget(
  prefix: string,
  match: RepeatedPatternMatch,
): string | null {
  if (!prefix || !looksLikeInternalPreamble(prefix)) {
    return null;
  }

  const rawVisibleSuffix = buildRawVisibleSuffix(match);
  if (rawVisibleSuffix && prefix.includes(rawVisibleSuffix)) {
    return rawVisibleSuffix;
  }

  for (let repeats = match.fullRepeats; repeats >= 2; repeats -= 1) {
    const candidate = match.unit.repeat(repeats);
    if (candidate.length <= match.unit.length || !rawVisibleSuffix.startsWith(candidate)) {
      continue;
    }
    if (prefix.includes(candidate)) {
      return candidate;
    }
  }

  const explicitlyNamedLiteral = findExplicitSingleTargetLiteralInPreamble(prefix);
  if (!explicitlyNamedLiteral) {
    return null;
  }

  if (
    rawVisibleSuffix.startsWith(explicitlyNamedLiteral) ||
    explicitlyNamedLiteral.startsWith(rawVisibleSuffix) ||
    rawVisibleSuffix.includes(explicitlyNamedLiteral) ||
    explicitlyNamedLiteral.includes(match.unit) ||
    match.unit.includes(explicitlyNamedLiteral)
  ) {
    return explicitlyNamedLiteral;
  }

  return null;
}

function selectVisibleSuffixReplacement(params: {
  prefix: string;
  match: RepeatedPatternMatch;
  context: "delimiter" | "no-delimiter";
}): string | null {
  const { prefix, match, context } = params;

  const explicitTarget = findExplicitVisibleSuffixTarget(prefix, match);
  if (explicitTarget) {
    return explicitTarget;
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
  const match = matchStructuredRepeatedPrefixPattern(suffix);
  if (!match) {
    return suffix;
  }

  return selectVisibleSuffixReplacement({ prefix, match, context: "delimiter" }) ?? suffix;
}

function findExplicitSingleTargetLiteralInPreamble(text: string): string | null {
  if (
    !text ||
    !looksLikeInternalPreamble(text) ||
    !SINGLE_ANSWER_INTENT_RE.test(text) ||
    !EXACT_TARGET_HINT_RE.test(text)
  ) {
    return null;
  }

  const literals = [...text.matchAll(INLINE_CODE_LITERAL_RE)]
    .map((match) => match[1]?.trim() ?? "")
    .filter((literal) => literal.length > 0);
  const uniqueLiterals = [...new Set(literals)];
  if (uniqueLiterals.length !== 1) {
    return null;
  }

  return uniqueLiterals[0] ?? null;
}

function extractExplicitRepeatedLiteralFromRunawayText(text: string): string | null {
  const literal = findExplicitSingleTargetLiteralInPreamble(text);
  if (!literal || !looksStructuredRepeatedUnit(literal)) {
    return null;
  }

  const literalCount = text.split(literal).length - 1;
  if (literalCount < 3) {
    return null;
  }

  const lastLiteralIndex = text.lastIndexOf(literal);
  if (lastLiteralIndex < 0) {
    return null;
  }

  const trailingJunk = text.slice(lastLiteralIndex + literal.length);
  if (!trailingJunk) {
    return null;
  }

  return literal;
}

export function extractStructuredRepeatedVisibleSuffix(text: string): string {
  if (!text) {
    return text;
  }

  const maxUnitLength = Math.floor(text.length / 2);
  for (let unitLength = 1; unitLength <= maxUnitLength; unitLength += 1) {
    for (let tailLength = 0; tailLength < unitLength; tailLength += 1) {
      const unitEnd = text.length - tailLength;
      const unitStart = unitEnd - unitLength;
      if (unitStart < 0) {
        continue;
      }

      const unit = text.slice(unitStart, unitEnd);
      if (!looksStructuredRepeatedUnit(unit)) {
        continue;
      }

      const tail = text.slice(unitEnd);
      if (tail && tail !== unit.slice(0, tail.length)) {
        continue;
      }

      let start = unitStart;
      let fullRepeats = 1;
      while (start - unitLength >= 0 && text.slice(start - unitLength, start) === unit) {
        start -= unitLength;
        fullRepeats += 1;
      }
      const prefix = text.slice(0, start);
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
