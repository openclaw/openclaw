const STRUCTURED_REPEAT_HINT_RE = /[\s\d_\-~"'.,:;!?()[\]{}/\\]/;
const MIN_STRUCTURED_REPEAT_UNIT_LENGTH = 8;
const VISIBLE_SUFFIX_BOUNDARY_RE = /[.!?:;)\]}>`'"]$/;
const INTERNAL_PREAMBLE_HINT_RE =
  /\b(?:the user|instruction|output content|reply with|reply to|final response|general instruction|i will|i must|internal planning|plan:)\b/i;

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

export function collapseStructuredRepeatedPrefixPattern(text: string): string {
  if (!text) {
    return text;
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
      return unit;
    }
  }

  return text;
}

export function extractStructuredRepeatedVisibleSuffix(text: string): string {
  const collapsedWholeText = collapseStructuredRepeatedPrefixPattern(text);
  if (collapsedWholeText !== text) {
    return collapsedWholeText;
  }
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
      if (
        fullRepeats < 2 ||
        !endsAtVisibleSuffixBoundary(prefix) ||
        !looksLikeInternalPreamble(prefix)
      ) {
        continue;
      }

      return unit;
    }
  }

  return text;
}
