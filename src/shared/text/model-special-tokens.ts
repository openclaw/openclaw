/**
 * Strip model control tokens leaked into assistant text output.
 *
 * Models like GLM-5 and DeepSeek sometimes emit internal delimiter tokens
 * (e.g. `<|assistant|>`, `<|tool_call_result_begin|>`, `<｜begin▁of▁sentence｜>`)
 * in their responses. These use the universal `<|...|>` convention (ASCII or
 * full-width pipe variants) and should never reach end users.
 *
 * Matches inside fenced code blocks or inline code spans are preserved so
 * that documentation / examples that reference these tokens are not corrupted.
 *
 * This is a provider bug — no upstream fix tracked yet.
 * Remove this function when upstream providers stop leaking tokens.
 * @see https://github.com/openclaw/openclaw/issues/40020
 */
import { findCodeRegions, isInsideCode } from "./code-regions.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;
const CHANNEL_DELIMITER_RE = /<channel\|>/gi;
const STRUCTURED_REPEAT_HINT_RE = /[\s\d_\-`~"'.,:;!?()[\]{}/\\]/;
const MIN_STRUCTURED_REPEAT_UNIT_LENGTH = 8;

function overlapsCodeRegion(
  start: number,
  end: number,
  codeRegions: { start: number; end: number }[],
): boolean {
  return codeRegions.some((region) => start < region.end && end > region.start);
}

function shouldInsertSeparator(before: string | undefined, after: string | undefined): boolean {
  return Boolean(before && after && !/\s/.test(before) && !/\s/.test(after));
}

function collapseStructuredWholeStringRepetition(text: string): string {
  if (!text) {
    return text;
  }

  for (let unitLength = 1; unitLength <= Math.floor(text.length / 2); unitLength += 1) {
    if (text.length % unitLength !== 0) {
      continue;
    }

    const repeatCount = text.length / unitLength;
    if (repeatCount < 2) {
      continue;
    }

    const unit = text.slice(0, unitLength);
    const looksStructured =
      unitLength >= MIN_STRUCTURED_REPEAT_UNIT_LENGTH || STRUCTURED_REPEAT_HINT_RE.test(unit);
    if (!looksStructured) {
      continue;
    }

    if (unit.repeat(repeatCount) === text) {
      return unit;
    }
  }

  return text;
}

export function stripModelSpecialTokens(text: string): string {
  if (!text) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  CHANNEL_DELIMITER_RE.lastIndex = 0;
  if (!MODEL_SPECIAL_TOKEN_RE.test(text) && !CHANNEL_DELIMITER_RE.test(text)) {
    return text;
  }
  MODEL_SPECIAL_TOKEN_RE.lastIndex = 0;
  CHANNEL_DELIMITER_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let lastChannelDelimiterEnd: number | null = null;
  for (const match of text.matchAll(CHANNEL_DELIMITER_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    if (!isInsideCode(start, codeRegions) && !overlapsCodeRegion(start, end, codeRegions)) {
      lastChannelDelimiterEnd = end;
    }
  }
  if (lastChannelDelimiterEnd !== null) {
    return collapseStructuredWholeStringRepetition(
      stripModelSpecialTokens(text.slice(lastChannelDelimiterEnd)),
    );
  }

  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(MODEL_SPECIAL_TOKEN_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    out += text.slice(cursor, start);
    if (isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)) {
      out += matched;
    } else if (shouldInsertSeparator(text[start - 1], text[end])) {
      out += " ";
    }
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}
