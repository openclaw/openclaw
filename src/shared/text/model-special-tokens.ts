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
import {
  collapseRepeatedVisibleSuffixAfterDelimiter,
  findExplicitSingleTargetLiteralInPreamble,
} from "./repeated-visible-suffix.js";

// Match both ASCII pipe <|...|> and full-width pipe <｜...｜> (U+FF5C) variants.
const MODEL_SPECIAL_TOKEN_RE = /<[|｜][^|｜]*[|｜]>/g;
const CHANNEL_DELIMITER_RE = /<channel\|>/gi;
const CHANNEL_DELIMITER_PREFIX_HARD_HINT_RE = /\b(?:internal planning|plan:)/i;
const CHANNEL_DELIMITER_PREFIX_LONG_HINT_RE =
  /\b(?:reply with|reply to|nothing else|output content|output the text directly|direct instruction|current session|i will output|i will reply|i must output|i must reply|i must adhere)\b/i;
const CHANNEL_DELIMITER_LITERAL_SUFFIX_HINT_RE =
  /^(?:token\b|delimiter\b|marker\b|literal(?:ly)?\b|means?\b|identif(?:y|ies)\b|splits?\b|between\b|inside\b|outside\b)/i;
const CHANNEL_DELIMITER_LITERAL_PREFIX_HINT_RE =
  /\b(?:phrase|token|delimiter|marker|literal(?:ly)?)\b[^\n]{0,40}$/i;
const CHANNEL_DELIMITER_HINT_WINDOW_CHARS = 240;
const CHANNEL_DELIMITER_TRAILING_LITERAL_HINT_RE =
  /\b(?:token|delimiter|marker|literal(?:ly)?|use|type|contains?|ending|ends?\s+with)\b/i;

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

function getChannelDelimiterAttachment(text: string, start: number, end: number) {
  const before = text[start - 1];
  const after = text[end];

  return {
    attachedBefore: Boolean(before && !/\s/.test(before)),
    attachedAfter: Boolean(after && !/\s/.test(after)),
  };
}

function looksLikeLeakedChannelDelimiterPrefix(
  prefix: string,
  attachment: { attachedBefore: boolean; attachedAfter: boolean },
  suffix: string,
): boolean {
  const trimmed = prefix.trim();
  const trimmedSuffix = suffix.trimStart();
  if (!trimmed) {
    return false;
  }

  const recentTrimmed = trimmed.slice(-CHANNEL_DELIMITER_HINT_WINDOW_CHARS);
  if (
    CHANNEL_DELIMITER_LITERAL_PREFIX_HINT_RE.test(recentTrimmed) ||
    CHANNEL_DELIMITER_LITERAL_SUFFIX_HINT_RE.test(trimmedSuffix)
  ) {
    return false;
  }

  if (!trimmedSuffix) {
    return (
      CHANNEL_DELIMITER_PREFIX_HARD_HINT_RE.test(recentTrimmed) ||
      (trimmed.length >= 120 && CHANNEL_DELIMITER_PREFIX_LONG_HINT_RE.test(recentTrimmed))
    );
  }

  if (CHANNEL_DELIMITER_PREFIX_HARD_HINT_RE.test(recentTrimmed)) {
    return true;
  }

  return (
    trimmed.length >= 120 &&
    CHANNEL_DELIMITER_PREFIX_LONG_HINT_RE.test(recentTrimmed) &&
    (attachment.attachedBefore || attachment.attachedAfter || /^\S/.test(trimmedSuffix))
  );
}

function getRecentChannelDelimiterPrefix(text: string, start: number): string {
  return text.slice(0, start);
}

function stripTrailingChannelDelimiters(text: string): string {
  let next = text;

  while (next) {
    const codeRegions = findCodeRegions(next);
    let end = next.length;
    while (end > 0 && /\s/.test(next[end - 1] ?? "")) {
      end -= 1;
    }
    const start = end - "<channel|>".length;
    if (start < 0) {
      return next;
    }
    const candidate = next.slice(start, end);
    if (!/^<channel\|>$/i.test(candidate)) {
      return next;
    }
    if (isInsideCode(start, codeRegions) || overlapsCodeRegion(start, end, codeRegions)) {
      return next;
    }
    const prefix = next.slice(0, start).trimEnd().slice(-80);
    if (CHANNEL_DELIMITER_TRAILING_LITERAL_HINT_RE.test(prefix)) {
      return next;
    }
    next = next.slice(0, start) + next.slice(end);
  }

  return next;
}

function stripModelSpecialTokensImpl(text: string): string {
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
  const channelDelimiterMatches: { start: number; end: number }[] = [];
  for (const match of text.matchAll(CHANNEL_DELIMITER_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    const end = start + matched.length;
    const attachment = getChannelDelimiterAttachment(text, start, end);
    if (
      !isInsideCode(start, codeRegions) &&
      !overlapsCodeRegion(start, end, codeRegions) &&
      looksLikeLeakedChannelDelimiterPrefix(
        getRecentChannelDelimiterPrefix(text, start),
        attachment,
        text.slice(end),
      )
    ) {
      channelDelimiterMatches.push({ start, end });
    }
  }
  for (let idx = channelDelimiterMatches.length - 1; idx >= 0; idx -= 1) {
    const channelDelimiterMatch = channelDelimiterMatches[idx];
    const prefix = text.slice(0, channelDelimiterMatch.end);
    const explicitLiteral = findExplicitSingleTargetLiteralInPreamble(prefix);
    const rawVisibleSuffix = stripModelSpecialTokensImpl(text.slice(channelDelimiterMatch.end));
    if (explicitLiteral && rawVisibleSuffix.trim() === explicitLiteral.trim()) {
      return explicitLiteral;
    }
    const visibleSuffix = stripTrailingChannelDelimiters(rawVisibleSuffix);
    if (!visibleSuffix.trim()) {
      if (explicitLiteral?.toLowerCase() === "<channel|>") {
        return explicitLiteral;
      }
      continue;
    }

    return collapseRepeatedVisibleSuffixAfterDelimiter(prefix, visibleSuffix);
  }
  if (channelDelimiterMatches.length > 0) {
    return "";
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

export function stripModelSpecialTokens(text: string): string {
  return stripModelSpecialTokensImpl(text);
}
