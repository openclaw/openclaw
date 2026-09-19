import { findCodeRegions, isInsideCode } from "./code-regions.js";

const INVISIBLE_FORMAT_CHAR_CLASS = "\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff";

function withOptionalFormatChars(value: string): string {
  let pattern = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    pattern += `${char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}[${INVISIBLE_FORMAT_CHAR_CLASS}]*`;
  }
  return pattern;
}

const MINIMAX_TOOL_CALL_NAME_PATTERN = withOptionalFormatChars("minimax:tool_call");
const MINIMAX_TOOL_CALL_NAME_RE = new RegExp(MINIMAX_TOOL_CALL_NAME_PATTERN, "i");

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export function stripMinimaxToolCallXml(text: string): string {
  const encodedTransportBoundaryRe = /\]?<\]minimax\[>\[/g;
  const encodedToolCallOpenRe = /\]?<\]minimax\[>\[<tool_call>/g;
  const encodedToolCallCloseRe = /\]?<\]minimax\[>\[<\/tool_call>/g;
  if (!text || (!MINIMAX_TOOL_CALL_NAME_RE.test(text) && !encodedToolCallOpenRe.test(text))) {
    return text;
  }
  encodedToolCallOpenRe.lastIndex = 0;

  const sourceCodeRegions = findCodeRegions(text);
  let normalized = "";
  let envelopeCursor = 0;
  for (const openMatch of text.matchAll(encodedToolCallOpenRe)) {
    const start = openMatch.index;
    if (start < envelopeCursor || isInsideCode(start, sourceCodeRegions)) {
      continue;
    }

    encodedToolCallCloseRe.lastIndex = start + openMatch[0].length;
    let closeMatch = encodedToolCallCloseRe.exec(text);
    while (closeMatch && isInsideCode(closeMatch.index, sourceCodeRegions)) {
      closeMatch = encodedToolCallCloseRe.exec(text);
    }
    if (!closeMatch) {
      // A later opening cannot find a closing marker once this search reaches the end.
      break;
    }

    const end = closeMatch.index + closeMatch[0].length;
    normalized += text.slice(envelopeCursor, start);
    if (sourceCodeRegions.some((region) => region.start >= start && region.end <= end)) {
      envelopeCursor = end;
      continue;
    }
    normalized += text.slice(start, end).replace(encodedTransportBoundaryRe, "");
    envelopeCursor = end;
  }
  normalized += text.slice(envelopeCursor);

  if (!MINIMAX_TOOL_CALL_NAME_RE.test(normalized)) {
    return normalized;
  }

  const codeRegions = findCodeRegions(normalized);
  const minimaxToolXmlRe = new RegExp(
    `<invoke\\b[^>]*>[\\s\\S]*?<\\/invoke>|<\\/?${MINIMAX_TOOL_CALL_NAME_PATTERN}>`,
    "gi",
  );
  let result = "";
  let cursor = 0;
  for (const match of normalized.matchAll(minimaxToolXmlRe)) {
    const start = match.index ?? 0;
    if (isInsideCode(start, codeRegions)) {
      continue;
    }
    result += normalized.slice(cursor, start);
    cursor = start + match[0].length;
  }
  result += normalized.slice(cursor);
  return result;
}
