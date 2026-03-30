import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const TOOL_CALL_TAG_RE = /<\s*(\/?)\s*tool_call\b[^<>]*>/gi;
const TOOL_CALL_TAG_QUICK_RE = /<\s*\/?\s*tool_call\b/i;

function stripRelevantMemoriesTags(text: string): string {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return text;
  }
  MEMORY_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inMemoryBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inMemoryBlock = true;
      }
    } else if (isClose) {
      inMemoryBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inMemoryBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

function stripToolCallTags(text: string): string {
  if (!text || !TOOL_CALL_TAG_QUICK_RE.test(text)) {
    return text;
  }
  TOOL_CALL_TAG_RE.lastIndex = 0;

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;

  for (const match of text.matchAll(TOOL_CALL_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    if (!inToolCallBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose) {
        inToolCallBlock = true;
      }
    } else if (isClose) {
      inToolCallBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

export function stripAssistantInternalScaffolding(
  text: string,
  options?: { trimStart?: boolean },
): string {
  const withoutReasoning = stripReasoningTagsFromText(text, { mode: "preserve", trim: "start" });
  const withoutToolCalls = stripToolCallTags(withoutReasoning);
  const cleaned = stripRelevantMemoriesTags(withoutToolCalls);
  return options?.trimStart === false ? cleaned : cleaned.trimStart();
}
