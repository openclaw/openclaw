import { findCodeRegions, isInsideCode } from "./code-regions.js";

/**
 * Strip `<tool_call>...</tool_call>` and `<function_calls>...</function_calls>`
 * XML blocks that models sometimes emit as text instead of structured tool-use
 * blocks. Respects code fences so literal examples are preserved.
 *
 * Unclosed opening tags hide everything from the tag to end-of-string,
 * consistent with how `stripRelevantMemoriesTags` handles incomplete blocks.
 *
 * @see https://github.com/openclaw/openclaw/issues/60494
 */
const GENERIC_TOOL_CALL_QUICK_RE = /<\s*\/?\s*(?:tool_call|function_calls?)\b/i;

// Matches opening and closing tags individually for the state-machine pass.
// String.prototype.replace auto-resets lastIndex before each call, so a
// module-level /g regex is safe here (unlike matchAll which requires manual
// reset — see MEMORY_TAG_RE in assistant-visible-text.ts).
const GENERIC_TOOL_CALL_TAG_RE = /<\s*(\/?)\s*(tool_call|function_calls?)\b[^>]*>/gi;

export function stripGenericToolCallXml(text: string): string {
  if (!text) {
    return text;
  }
  if (!GENERIC_TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;

  for (const match of text.matchAll(GENERIC_TOOL_CALL_TAG_RE)) {
    const idx = match.index ?? 0;
    if (isInsideCode(idx, codeRegions)) {
      continue;
    }

    const isClose = match[1] === "/";
    const isSelfClosing = match[0].endsWith("/>");
    if (!inToolCallBlock) {
      result += text.slice(lastIndex, idx);
      if (!isClose && !isSelfClosing) {
        inToolCallBlock = true;
      }
    } else if (isClose) {
      inToolCallBlock = false;
    }

    lastIndex = idx + match[0].length;
  }

  // If still inside an unclosed block, hide the remaining content (consistent
  // with stripRelevantMemoriesTags unclosed-block handling).
  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}
