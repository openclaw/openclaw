import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/payload.js";
import { escapeRegExp } from "../regexp.js";
import { findCodeRegions, isInsideCode, stripLinesOutsideCode } from "./code-ranges.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;
const traceIconHeads = ["📊", "🛠️", "📖", "📝", "🔍", "🔎", "⚙️"].flatMap((icon) => [
  [icon],
  ["⚠️", icon],
]);
const traceChannelHeads = ["tool call", "tool result", "function call"].flatMap((name) =>
  ["", "-", "_", " "].flatMap((separator) =>
    [":", "="].map((delimiter) => [name.replace(" ", separator), delimiter]),
  ),
);
// Literal head parts, separated by optional whitespace, own both batch and stream activation.
const traceLineRules = [
  {
    heads: traceIconHeads,
    body: /\s*(?:Session Status|Exec|Read|Edit|Write|Patch|Search|Open|Click|Find|Screenshot|Update Plan|Tool Call|Tool Result|Function Call|Shell|Command)\s*:/,
  },
  {
    // Historical warnings include the older "(agent) failed" shape.
    heads: [["⚠️", "🛠️"]],
    body: /\s+(?:(?:Exec|Bash)\s+failed(?:(?:\s+\(exit\s+-?\d+\))|(?:\s*:[^\r\n]*))?|\S[^\r\n]*\s+\(agent\)`{0,2}\s+failed(?:\s*:[^\r\n]*)?)\s*$/,
  },
  {
    heads: [["🛠️"]],
    body: /\s*(?:(?:(?:elevated|pty)\b\s*(?:·|,)\s*)+)?(?:`{1,2}\s*\S|(?:run|check|fetch|pull|push|view|show|list|switch|create|merge|rebase|stage|restore|reset|stash|search|find|print|copy|move|remove|install|start|cd|git|pnpm|npm|yarn|bun|node|python|python3|bash|sh)\b)/,
  },
  { heads: traceChannelHeads, body: /(?:)/ },
];
export const INTERNAL_TRACE_LINE_RE = new RegExp(
  `^(?:>\\s*)?(?:${traceLineRules
    .map(
      ({ heads, body }) =>
        `(?:${heads.map((parts) => parts.map(escapeRegExp).join("\\s*")).join("|")})${body.source}`,
    )
    .join("|")})`,
  "i",
);
export const traceLineHeads = traceLineRules.flatMap(({ heads }) =>
  heads.flatMap((parts) => [parts, [">", ...parts]]),
);
const INTERNAL_TRACE_HEAD_RE = new RegExp(
  `^[^\\S\\r\\n]*(?:${traceLineHeads
    .map((parts) => parts.map(escapeRegExp).join("\\s*"))
    .join("|")})`,
  "im",
);

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export function stripMinimaxToolCallXml(text: string): string {
  const encodedTransportBoundaryRe = /\]?<\]minimax\[>\[/g;
  const encodedToolCallOpenRe = /\]?<\]minimax\[>\[<tool_call>/g;
  const encodedToolCallCloseRe = /\]?<\]minimax\[>\[<\/tool_call>/g;
  if (!text || (!/minimax:tool_call/i.test(text) && !encodedToolCallOpenRe.test(text))) {
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

  if (!/minimax:tool_call/i.test(normalized)) {
    return normalized;
  }

  const codeRegions = findCodeRegions(normalized);
  const minimaxToolXmlRe = /<invoke\b[^>]*>[\s\S]*?<\/invoke>|<\/?minimax:tool_call>/gi;
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

export function stripLegacyBracketToolCallBlocks(text: string): string {
  if (!text || !LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let cursor = 0;
  for (const openMatch of text.matchAll(/\[\s*TOOL_(CALL|RESULT)\s*\]/gi)) {
    const openStart = openMatch.index;
    if (openStart < cursor || isInsideCode(openStart, codeRegions)) {
      continue;
    }
    const payloadStart = openStart + openMatch[0].length;
    const isResult = openMatch[1]?.toUpperCase() === "RESULT";
    const closeRe = isResult ? /\[\s*\/\s*TOOL_RESULT\s*\]/gi : /\[\s*\/\s*TOOL_CALL\s*\]/gi;
    closeRe.lastIndex = payloadStart;
    let closeMatch = closeRe.exec(text);
    while (closeMatch && isInsideCode(closeMatch.index, codeRegions)) {
      closeMatch = closeRe.exec(text);
    }
    const payload = text.slice(payloadStart, closeMatch?.index);
    const isToolPayload = isResult
      ? /^\s*[{[]/.test(payload) ||
        /\b(?:tool|result|output|content)\s*=>/i.test(payload) ||
        /\b(?:tool|result|output|content)\s*:/i.test(payload)
      : /\btool\s*=>\s*["'][A-Za-z_][A-Za-z0-9_.:-]{0,119}["']/i.test(payload) &&
        /\bargs\s*=>/i.test(payload);
    if (!isToolPayload) {
      continue;
    }
    result += text.slice(cursor, openStart);
    cursor = closeMatch ? closeMatch.index + closeMatch[0].length : text.length;
    if (cursor === text.length) {
      break;
    }
  }
  return result + text.slice(cursor);
}

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

export function stripAssistantInternalTraceLines(text: string): string {
  // Every removable line contains a canonical head, even when whitespace precedes it.
  if (!INTERNAL_TRACE_HEAD_RE.test(text)) {
    return text;
  }
  return stripLinesOutsideCode(text, (line) => INTERNAL_TRACE_LINE_RE.test(line.trim()));
}

export function stripInvisibleAssistantText(text: string): string {
  return /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*$/u.test(text) ? "" : text;
}

export const plainToolCallTransform = (text: string) =>
  stripPlainTextToolCallBlocks(text, { resolveProtectedRanges: findCodeRegions });
