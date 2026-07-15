// Reasoning tag helpers find and remove model reasoning tag blocks from text.
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { findFinalTagMatches } from "./final-tags.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";

// Reasoning tags may carry a model-specific namespace prefix (e.g. Anthropic's
// `antml:`, MiniMax's `mm:`). Accept the known prefixes so namespaced variants
// like `<mm:think>` are stripped instead of leaking into visible output.
const QUICK_TAG_RE = /<\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking|final)\b/i;
const THINKING_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/gi;
// Fullwidth-bracketed reasoning tags. Models occasionally emit CJK fullwidth
// quotation marks (U+300C 「, U+300D 」, U+300E 『, U+300F 』) around reasoning
// tag names instead of ASCII angle brackets. Match such regions so they can be
// stripped by index without rewriting visible CJK quotes elsewhere in the text.
const FULLWIDTH_TAG_REGION_RE =
  /[\u300C\u300E]\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking|final)[^\u300C\u300D\u300E\u300F]*[\u300D\u300F]/gi;
const FULLWIDTH_TAG_NAME_RE =
  /^\s*\/?\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking|final)\s*$/i;

function stripFullwidthReasoningTags(text: string): string {
  const matches = text.matchAll(FULLWIDTH_TAG_REGION_RE);
  const regions: Array<{ index: number; length: number }> = [];
  const codeRegions = findCodeRegions(text);
  for (const m of matches) {
    const idx = m.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }
    const inner = m[0].slice(1, -1);
    if (FULLWIDTH_TAG_NAME_RE.test(inner)) {
      regions.push({ index: idx, length: m[0].length });
    }
  }
  if (regions.length === 0) {
    return text;
  }
  let result = text;
  for (let i = regions.length - 1; i >= 0; i--) {
    const r = regions[i]!;
    result = result.slice(0, r.index) + result.slice(r.index + r.length);
  }
  return result;
}

function applyTrim(value: string, mode: ReasoningTagTrim): string {
  if (mode === "none") {
    return value;
  }
  if (mode === "start") {
    return value.trimStart();
  }
  return value.trim();
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
  // Strip fullwidth-bracketed reasoning/final tags by index so visible CJK
  // quotes elsewhere in the text are preserved. Pre-step before ASCII matching.
  const fullwidthStripped = stripFullwidthReasoningTags(text);
  const quickTagMatch = QUICK_TAG_RE.test(fullwidthStripped);
  if (!quickTagMatch && fullwidthStripped === text) {
    // No fullwidth regions matched and no ASCII tag markers — return original
    // text untouched so visible CJK quotes are not perturbed.
    return text;
  }
  let cleaned = fullwidthStripped;

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  const matches = findFinalTagMatches(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  const hasThinkingTag = THINKING_TAG_RE.test(cleaned);
  THINKING_TAG_RE.lastIndex = 0;
  if (matches.length === 0 && !hasThinkingTag) {
    // No ASCII tags remain; if fullwidth regions were stripped, return the
    // pre-stripped text so those tags don't leak back into the visible output.
    return fullwidthStripped;
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

  for (const match of cleaned.matchAll(THINKING_TAG_RE)) {
    const idx = match.index ?? 0;
    const isClose = match[1] === "/";

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
      thinkingDepth = 1;
      firstUnclosedContentIndex = idx + match[0].length;
    } else if (isClose) {
      thinkingDepth -= 1;
      if (thinkingDepth === 0) {
        firstUnclosedContentIndex = undefined;
      }
    } else {
      thinkingDepth += 1;
    }

    lastIndex = idx + match[0].length;
  }

  if (thinkingDepth === 0 || mode === "preserve") {
    result += cleaned.slice(lastIndex);
  }

  const trimmedResult = applyTrim(result, trimMode);
  if (
    mode === "strict" &&
    thinkingDepth > 0 &&
    !trimmedResult &&
    firstUnclosedContentIndex !== undefined &&
    cleaned.trim()
  ) {
    return applyTrim(cleaned.slice(firstUnclosedContentIndex), trimMode);
  }

  return trimmedResult;
}
