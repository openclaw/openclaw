// Internal helper to strip <relevant_memories> tags from text.
// Kept out of the plugin-sdk/text-runtime barrel to avoid growing the public SDK surface.
import { findCodeRegions, isInsideCode } from "./code-regions.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/** Strip <relevant_memories>...</relevant_memories> blocks, preserving inline code. */
export function stripRelevantMemoriesTags(text: string): string {
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
