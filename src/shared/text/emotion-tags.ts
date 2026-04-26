import type { EmotionMode } from "../../emotion-mode.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";

const EMOTION_TAG_RE = /\[([A-Za-z]+(?:[ /-][A-Za-z]+){0,7})\](?!\()/g;
const TRAILING_EMOTION_TAG_RE = /\[[A-Za-z]+(?:[ /-][A-Za-z]+){0,7}$/u;
const EMOTION_TAG_WORDS = new Set([
  "amused",
  "angry",
  "anxious",
  "apologetic",
  "astonished",
  "awed",
  "awkwardly",
  "breathless",
  "brightly",
  "calm",
  "careful",
  "cheerfully",
  "chuckle",
  "chuckles",
  "clear",
  "confident",
  "curious",
  "deadpan",
  "direct",
  "disappointed",
  "distant",
  "dramatic",
  "dryly",
  "embarrassed",
  "empathetic",
  "encouraging",
  "energetic",
  "exhale",
  "exhales",
  "excited",
  "fast",
  "fearful",
  "firmly",
  "flatly",
  "frustrated",
  "gasp",
  "gasps",
  "guilty",
  "hesitate",
  "hesitates",
  "interested",
  "irritated",
  "laugh",
  "laughs",
  "lonely",
  "measured",
  "mischievously",
  "nervous",
  "panicked",
  "pause",
  "pauses",
  "playfully",
  "polished",
  "proudly",
  "quietly",
  "quizzically",
  "realize",
  "realizing",
  "relieved",
  "sad",
  "sarcastic",
  "serious",
  "shaken",
  "sharp",
  "sigh",
  "sighs",
  "sincere",
  "skeptical",
  "slow",
  "slowly",
  "softly",
  "sorrowful",
  "steady",
  "surprised",
  "tenderly",
  "tense",
  "thoughtful",
  "voice",
  "breaking",
  "warmly",
  "whisper",
  "whispers",
]);

// Precomputed first-character index so trailing-partial prefix checks don't
// allocate a new array from EMOTION_TAG_WORDS on every call (per Copilot
// review on emotion-tags.ts:196 — this runs on every streamed delta).
const EMOTION_TAG_WORDS_BY_FIRST_CHAR: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const word of EMOTION_TAG_WORDS) {
    const first = word.charAt(0);
    if (!first) {
      continue;
    }
    const bucket = map.get(first);
    if (bucket) {
      bucket.push(word);
    } else {
      map.set(first, [word]);
    }
  }
  return map;
})();

function isAllowlistPrefix(partial: string): boolean {
  if (!partial) {
    return true;
  }
  const bucket = EMOTION_TAG_WORDS_BY_FIRST_CHAR.get(partial.charAt(0));
  if (!bucket) {
    return false;
  }
  for (const entry of bucket) {
    if (entry.startsWith(partial)) {
      return true;
    }
  }
  return false;
}

type StripEmotionTagsOptions = {
  /**
   * Legacy name: when true, callers allow this sanitizer to treat an allowlisted
   * trailing partial tag fragment as tag syntax during streaming.
   */
  allowTrailingPartialTag?: boolean;
};

export type StripEmotionTagsResult = {
  text: string;
  changed: boolean;
};

function replacementPreservesWordBoundary(source: string, offset: number, length: number): string {
  const before = source[offset - 1];
  const after = source[offset + length];
  return before && after && !/\s/u.test(before) && !/\s/u.test(after) ? " " : "";
}

function isInlineSpacing(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

function isEmotionTagBoundary(char: string | undefined, side: "before" | "after"): boolean {
  if (!char) {
    return true;
  }
  if (side === "before") {
    // `[` is a valid "before" boundary so back-to-back tags `[warmly][softly]`
    // each see the previous `]` (resolving the `before` of the second tag) AND
    // the next `[` (resolving the `after` of the first tag) as boundaries.
    // Per chatgpt-codex P2 review on PR-D's emotion-tags.ts:117.
    return /[\s({>[\]"'`]/u.test(char);
  }
  // `[` is added to the "after" boundary so back-to-back tags `[a][b]` strip
  // (the first tag's "after" is the next `[`).
  return /[\s.,!?;:)\]}>/[\\"'`-]/u.test(char);
}

function isLikelyEmotionTag(text: string, index: number, rawTag: string, body: string): boolean {
  if (body.includes("  ")) {
    return false;
  }
  const trimmedBody = body.trim();
  if (!trimmedBody || /^(?:https?|www)\b/i.test(trimmedBody)) {
    return false;
  }
  const words = trimmedBody
    .split(/[ /-]+/u)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
  if (words.length === 0 || words.some((word) => !EMOTION_TAG_WORDS.has(word))) {
    return false;
  }
  const before = index > 0 ? text[index - 1] : undefined;
  const after = text[index + rawTag.length];
  return isEmotionTagBoundary(before, "before") && isEmotionTagBoundary(after, "after");
}

function stripTrailingPartialEmotionTag(text: string): StripEmotionTagsResult {
  if (!text.endsWith("[") && !TRAILING_EMOTION_TAG_RE.test(text)) {
    return { text, changed: false };
  }
  const codeRegions = findCodeRegions(text);
  if (text.endsWith("[")) {
    const index = text.length - 1;
    if (isInsideCode(index, codeRegions)) {
      return { text, changed: false };
    }
    const before = index > 0 ? text[index - 1] : undefined;
    if (!isEmotionTagBoundary(before, "before")) {
      return { text, changed: false };
    }
    const replacement = replacementPreservesWordBoundary(text, index, 1);
    return {
      text: text.slice(0, index) + replacement,
      changed: true,
    };
  }
  const trailingMatch = TRAILING_EMOTION_TAG_RE.exec(text);
  if (!trailingMatch || trailingMatch.index === undefined) {
    return { text, changed: false };
  }
  if (isInsideCode(trailingMatch.index, codeRegions)) {
    return { text, changed: false };
  }
  const before = trailingMatch.index > 0 ? text[trailingMatch.index - 1] : undefined;
  if (!isEmotionTagBoundary(before, "before")) {
    return { text, changed: false };
  }
  // Per Greptile P2 review: gate trailing-partial stripping on the EMOTION_TAG_WORDS
  // allowlist so messages ending with `[foobar` or `[some` aren't truncated mid-word.
  const partialBody = trailingMatch[0].slice(1).trim();
  if (partialBody.length > 0) {
    const partialWords = partialBody
      .split(/[ /-]+/u)
      .map((word) => word.toLowerCase())
      .filter(Boolean);
    if (partialWords.length === 0) {
      return { text, changed: false };
    }
    // For partial trails the LAST word is incomplete (still being streamed) — accept it
    // if it's a valid prefix of any allowlist word; require all earlier words to be
    // fully matched against the allowlist.
    const lastIdx = partialWords.length - 1;
    for (let i = 0; i < partialWords.length; i++) {
      const word = partialWords[i];
      if (i === lastIdx) {
        if (!isAllowlistPrefix(word)) {
          return { text, changed: false };
        }
      } else if (!EMOTION_TAG_WORDS.has(word)) {
        return { text, changed: false };
      }
    }
  }
  const replacement = replacementPreservesWordBoundary(
    text,
    trailingMatch.index,
    trailingMatch[0].length,
  );
  return {
    text: text.slice(0, trailingMatch.index) + replacement,
    changed: true,
  };
}

export function stripEmotionTags(
  text: string,
  options: StripEmotionTagsOptions = {},
): StripEmotionTagsResult {
  if (!text || !text.includes("[")) {
    return { text, changed: false };
  }

  const codeRegions = findCodeRegions(text);
  let changed = false;
  let result = "";
  let cursor = 0;

  for (const match of text.matchAll(EMOTION_TAG_RE)) {
    const index = match.index ?? 0;
    if (isInsideCode(index, codeRegions)) {
      continue;
    }
    const [rawTag, body] = match;
    if (!isLikelyEmotionTag(text, index, rawTag, body)) {
      continue;
    }
    result += text.slice(cursor, index);
    const replacement = replacementPreservesWordBoundary(text, index, rawTag.length);
    result += replacement;
    let nextCursor = index + rawTag.length;
    const before = index > 0 ? text[index - 1] : undefined;
    const after = text[nextCursor];
    const alreadySeparated =
      index === 0 || replacement === " " || (before ? /\s/u.test(before) || before === "]" : false);
    if (alreadySeparated && isInlineSpacing(after)) {
      nextCursor += 1;
    }
    cursor = nextCursor;
    changed = true;
  }

  if (!changed) {
    if (!options.allowTrailingPartialTag) {
      return { text, changed: false };
    }
    return stripTrailingPartialEmotionTag(text);
  }

  result += text.slice(cursor);
  if (!options.allowTrailingPartialTag) {
    return { text: result, changed };
  }
  const trailing = stripTrailingPartialEmotionTag(result);
  return {
    text: trailing.text,
    changed: changed || trailing.changed,
  };
}

export function sanitizeEmotionTagsForMode(
  text: string,
  mode: EmotionMode | undefined,
  options: StripEmotionTagsOptions = {},
): StripEmotionTagsResult {
  // Per Copilot reviews on emotion-tags.ts:274 / :282 / agent-runner-payloads.ts:145,146:
  // when callers pass `undefined` (no opinion about emotion mode), this layer
  // must be a no-op — the legacy contract was "strip everything" which silently
  // hides bracketed assistant text from non-emotion-aware callsites. The visible
  // chat layer (`sanitizeDirectiveAndEmotionTagsForDisplay`) and the writer
  // (`agent-runner-payloads`) both rely on this no-opinion no-op semantics.
  if (mode === undefined) {
    return { text, changed: false };
  }
  if (mode === "full") {
    if (!options.allowTrailingPartialTag) {
      return { text, changed: false };
    }
    return stripTrailingPartialEmotionTag(text);
  }
  return stripEmotionTags(text, options);
}
