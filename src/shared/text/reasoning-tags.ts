import {
  REASONING_TAG_NAMES,
  scanReasoningTags,
  stripReasoningTagsFromMarkdown,
} from "../../../packages/markdown-core/src/reasoning-tags-batch.js";
import { escapeRegExp } from "../regexp.js";
// Reasoning tag helpers find and remove model reasoning tag blocks from text.
import { FINAL_TAG_NAME, findFinalTagMatches, stripFinalTags } from "./final-tags.js";
import { createTagNameProbe } from "./tag-name-probe.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";
export type ReasoningTagScope = "all" | "leading";

export const THINKING_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "mm:think",
  "mm:thinking",
  "mm:thought",
] as const;

const REASONING_AND_FINAL_TAG_NAMES = [...REASONING_TAG_NAMES, FINAL_TAG_NAME];
const REASONING_OR_FINAL_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${REASONING_AND_FINAL_TAG_NAMES.map(escapeRegExp).join("|")})(?=[\\s/>])`,
  "i",
);

export function createReasoningTagProbe() {
  return createTagNameProbe(REASONING_AND_FINAL_TAG_NAMES);
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
    scope?: ReasoningTagScope;
    recoverUnclosed?: boolean;
  },
): string {
  // Without a recognized tag name, both canonical scans preserve the input, including padding.
  if (!text || !REASONING_OR_FINAL_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  const scope = options?.scope ?? "all";

  let cleaned = text;
  const matches = findFinalTagMatches(cleaned);
  if (matches.length > 0) {
    cleaned = stripFinalTags(cleaned);
  }
  const hasThinkingTag = scanReasoningTags(cleaned).tags.length > 0;
  if (matches.length === 0 && !hasThinkingTag) {
    return text;
  }

  const stripped = hasThinkingTag
    ? stripReasoningTagsFromMarkdown(cleaned, {
        mode,
        scope,
        recoverUnclosed: options?.recoverUnclosed,
      })
    : cleaned;
  if (trimMode === "none") {
    return stripped;
  }
  return trimMode === "start" ? stripped.trimStart() : stripped.trim();
}
