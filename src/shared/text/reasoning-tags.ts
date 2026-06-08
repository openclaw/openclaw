// Reasoning tag helpers find and remove model reasoning tag blocks from text.
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { findFinalTagMatches } from "./final-tags.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

const QUICK_TAG_RE =
  /<\s*\/?\s*(?:(?:antml:)?(?:think(?:ing)?|thought|reasoning)|antthinking|final)(?=\s|\/|>)/i;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*((?:antml:)?(?:think(?:ing)?|thought|reasoning)|antthinking)(?:\s[^<>]*|\/\s*)?>/gi;
const UNRECOVERABLE_UNCLOSED_TAG_RE = /^(?:antml:)?reasoning$/i;

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
}

function isSelfClosingThinkingTagText(tagText: string): boolean {
  return /\/\s*>$/.test(tagText);
}

function canRecoverLiteralTagMention(prefix: string, textAfterTag: string): boolean {
  if (!/\S/.test(prefix) || /^\s+tag\s+should\s+be\s+hidden\b/i.test(textAfterTag)) {
    return false;
  }
  return /^\s+(?:tag|tags|element|block)\b/i.test(textAfterTag);
}

/** Detects whether a stray reasoning close tag separates two visible text regions. */
export function hasOrphanReasoningCloseBoundary(params: {
  before: string;
  after: string;
}): boolean {
  return params.before.trim().length > 0 && params.after.trim().length > 0;
}

/** Strips model reasoning/final tags from visible text while preserving literal code examples. */
export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
  },
): string {
  if (!text) {
    return text;
  }
  if (!QUICK_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";

  let cleaned = text;
  const matches = findFinalTagMatches(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  const hasThinkingTag = THINKING_TAG_RE.test(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  if (matches.length === 0 && !hasThinkingTag) {
    return text;
  }
  if (matches.length > 0) {
    const finalMatches: Array<{ start: number; length: number; inCode: boolean }> = [];
    const preCodeRegions = findCodeRegions(cleaned);
    for (const match of matches) {
      const start = match.index;
      finalMatches.push({
        start,
        length: match.text.length,
        inCode: isInsideCode(start, preCodeRegions),
      });
    }

    for (let i = finalMatches.length - 1; i >= 0; i--) {
      const m = finalMatches[i];
      if (!m.inCode) {
        cleaned = cleaned.slice(0, m.start) + cleaned.slice(m.start + m.length);
      }
    }
  }

  const codeRegions = findCodeRegions(cleaned);

  THINKING_TAG_RE.lastIndex = 0;
  let result = "";
  let lastIndex = 0;
  let thinkingDepth = 0;
  let firstUnclosedContentIndex: number | undefined;
  let firstUnclosedTagName: string | undefined;
  let firstUnclosedTagText: string | undefined;

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";
    const tagName = match[2];
    const isSelfClosing = !isClose && isSelfClosingThinkingTagText(match[0]);

    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    if (thinkingDepth === 0) {
      if (isClose) {
        const afterIndex = idx + match[0].length;
        const before = cleaned.slice(lastIndex, idx);
        const after = cleaned.slice(afterIndex);
        if (hasOrphanReasoningCloseBoundary({ before, after })) {
          // A lone close tag after visible preamble means the hidden opening tag was
          // probably truncated; drop the preamble so partial reasoning is not leaked.
          result = "";
        } else {
          result += before;
        }
        lastIndex = afterIndex;
        continue;
      }
      result += cleaned.slice(lastIndex, idx);
      lastIndex = idx + match[0].length;
      if (isSelfClosing) {
        continue;
      }
      thinkingDepth = 1;
      firstUnclosedContentIndex = lastIndex;
      firstUnclosedTagName = tagName;
      firstUnclosedTagText = match[0];
    } else if (isClose) {
      thinkingDepth -= 1;
      if (thinkingDepth === 0) {
        firstUnclosedContentIndex = undefined;
        firstUnclosedTagName = undefined;
        firstUnclosedTagText = undefined;
      }
    } else if (isSelfClosing) {
      // Empty hidden-control tags should not keep later visible text hidden.
    } else {
      thinkingDepth += 1;
    }

    lastIndex = idx + match[0].length;
  }

  if (thinkingDepth === 0 || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  const unclosedTagIsRecoverable =
    !firstUnclosedTagName || !UNRECOVERABLE_UNCLOSED_TAG_RE.test(firstUnclosedTagName);
  const unclosedTagSuffix =
    firstUnclosedContentIndex === undefined ? "" : cleaned.slice(firstUnclosedContentIndex);
  if (
    mode === "strict" &&
    thinkingDepth > 0 &&
    trimmedResult &&
    firstUnclosedTagText !== undefined &&
    !unclosedTagIsRecoverable &&
    canRecoverLiteralTagMention(result, unclosedTagSuffix)
  ) {
    return applyTrim(result + firstUnclosedTagText + unclosedTagSuffix, trimMode);
  }

  if (
    mode === "strict" &&
    thinkingDepth > 0 &&
    !trimmedResult &&
    firstUnclosedContentIndex !== undefined &&
    unclosedTagIsRecoverable &&
    cleaned.trim()
  ) {
    return applyTrim(unclosedTagSuffix, trimMode);
  }

  return trimmedResult;
}
