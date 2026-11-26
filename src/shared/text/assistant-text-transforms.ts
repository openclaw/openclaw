import { stripPlainTextToolCallBlocks } from "../../../packages/tool-call-repair/src/payload.js";
import { escapeRegExp } from "../regexp.js";
import { findCodeRegions, isInsideCode, stripLinesOutsideCode } from "./code-ranges.js";
import { createQuotedStringScanner, parseXmlTagAt } from "./xml-tag-at.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;
const LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE = /\[\s*\/?\s*TOOL_(?:CALL|RESULT)\s*\]/i;
const LEGACY_BRACKET_OPEN_HEADERS = ["[TOOL_CALL]", "[TOOL_RESULT]"];
const MINIMAX_ENCODED_BOUNDARY = "<]minimax[>[";
const MINIMAX_ENCODED_TOOL_CALL = "<tool_call>";
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
export type MinimaxToolCallScan = {
  text: string;
  /** An incomplete transport envelope or invocation still owns the reply suffix. */
  pending: boolean;
  /** One more character can decide whether the incomplete transport prefix is still a candidate. */
  rescanWhileSuppressed?: boolean;
};

function findIncompleteEncodedToolCallStart(
  text: string,
  codeRegions: ReturnType<typeof findCodeRegions>,
): number | undefined {
  let boundary = text.lastIndexOf(MINIMAX_ENCODED_BOUNDARY);
  while (boundary >= 0) {
    const start = boundary > 0 && text[boundary - 1] === "]" ? boundary - 1 : boundary;
    const tail = text.slice(boundary + MINIMAX_ENCODED_BOUNDARY.length).toLowerCase();
    if (
      tail.length < MINIMAX_ENCODED_TOOL_CALL.length &&
      MINIMAX_ENCODED_TOOL_CALL.startsWith(tail) &&
      !isInsideCode(start, codeRegions)
    ) {
      return start;
    }
    boundary = text.lastIndexOf(MINIMAX_ENCODED_BOUNDARY, boundary - 1);
  }
  return undefined;
}

function findIncompleteInvocationStart(
  text: string,
  codeRegions: ReturnType<typeof findCodeRegions>,
): number | undefined {
  let start = text.lastIndexOf("<");
  while (start >= 0) {
    const tag = parseXmlTagAt(text, start);
    if (
      tag?.isTruncated &&
      tag.tagName === "invoke" &&
      !tag.isClose &&
      !isInsideCode(start, codeRegions)
    ) {
      return start;
    }
    start = text.lastIndexOf("<", start - 1);
  }
  return undefined;
}

export function scanMinimaxToolCallXml(
  text: string,
  options?: { recoverUnclosed?: boolean },
): MinimaxToolCallScan {
  const encodedTransportBoundaryRe = /\]?<\]minimax\[>\[/g;
  const encodedToolCallOpenRe = /\]?<\]minimax\[>\[<tool_call>/g;
  const encodedToolCallCloseRe = /\]?<\]minimax\[>\[<\/tool_call>/g;
  if (!text) {
    return { text, pending: false };
  }

  const hasMinimaxMarker = /minimax:tool_call/i.test(text);
  if (!hasMinimaxMarker && !text.includes(MINIMAX_ENCODED_BOUNDARY)) {
    return { text, pending: false };
  }

  const sourceCodeRegions = findCodeRegions(text);
  const incompleteEncodedStart = findIncompleteEncodedToolCallStart(text, sourceCodeRegions);
  encodedToolCallOpenRe.lastIndex = 0;
  if (
    !hasMinimaxMarker &&
    !encodedToolCallOpenRe.test(text) &&
    incompleteEncodedStart === undefined
  ) {
    return { text, pending: false };
  }
  encodedToolCallOpenRe.lastIndex = 0;

  let normalized = "";
  let envelopeCursor = 0;
  let pending = false;
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
      // The encoded envelope owns everything after an opening marker that has no close yet.
      normalized += text.slice(envelopeCursor, start);
      pending = true;
      envelopeCursor = text.length;
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
  if (incompleteEncodedStart !== undefined && incompleteEncodedStart >= envelopeCursor) {
    normalized += text.slice(envelopeCursor, incompleteEncodedStart);
    envelopeCursor = text.length;
    pending = true;
  }
  normalized += text.slice(envelopeCursor);

  if (!/minimax:tool_call/i.test(normalized)) {
    return {
      text: normalized,
      pending,
      rescanWhileSuppressed: incompleteEncodedStart !== undefined,
    };
  }

  const codeRegions = findCodeRegions(normalized);
  const minimaxToolXmlRe = /(<invoke\b[^>]*>)|<\/?minimax:tool_call>/gi;
  let result = "";
  let cursor = 0;
  for (const match of normalized.matchAll(minimaxToolXmlRe)) {
    const start = match.index;
    if (start < cursor || isInsideCode(start, codeRegions)) {
      continue;
    }
    let end = start + match[0].length;
    if (match[1]) {
      const tag = parseXmlTagAt(normalized, start);
      if (!tag || tag.isTruncated) {
        pending = true;
        result += normalized.slice(cursor, start);
        cursor = normalized.length;
        continue;
      }
      // Literal closers in JSON arguments or code do not end the invocation.
      const isInsideQuote = /^\s*[{[]/.test(normalized.slice(tag.end))
        ? createQuotedStringScanner(normalized, tag.end)
        : undefined;
      const closeRe = /<\/invoke>/gi;
      closeRe.lastIndex = tag.end;
      let close = closeRe.exec(normalized);
      const recoveryClose = close;
      while (
        close &&
        (isInsideQuote ? isInsideQuote(close.index) : isInsideCode(close.index, codeRegions))
      ) {
        close = closeRe.exec(normalized);
      }
      // Only terminal text can recover the legacy boundary when no unquoted close remains.
      if (!close && isInsideQuote && options?.recoverUnclosed !== false) {
        close = recoveryClose;
      }
      if (!close) {
        // An unfinished invocation must never publish its arguments while the provider streams.
        // Keeping the whole suffix hidden also preserves the boundary for a later real closer.
        pending = true;
        result += normalized.slice(cursor, start);
        cursor = normalized.length;
        continue;
      }
      end = close.index + close[0].length;
    }
    result += normalized.slice(cursor, start);
    cursor = end;
  }
  const incompleteInvocationStart = findIncompleteInvocationStart(normalized, codeRegions);
  if (incompleteInvocationStart !== undefined && incompleteInvocationStart >= cursor) {
    result += normalized.slice(cursor, incompleteInvocationStart);
    cursor = normalized.length;
    pending = true;
  } else {
    result += normalized.slice(cursor);
  }
  return {
    text: result,
    pending,
    rescanWhileSuppressed: incompleteEncodedStart !== undefined,
  };
}

export function stripMinimaxToolCallXml(
  text: string,
  options?: { recoverUnclosed?: boolean },
): string {
  return scanMinimaxToolCallXml(text, options).text;
}

export type LegacyBracketBlockScan = {
  text: string;
  /** An unclosed candidate can still change what the next append hides. */
  pending: boolean;
};

export function scanLegacyBracketToolCallBlocks(
  text: string,
  codeRegions: ReturnType<typeof findCodeRegions>,
): LegacyBracketBlockScan {
  let result = "";
  let cursor = 0;
  // An unfinished header can cross a Markdown checkpoint before its closing bracket.
  // An ordinary unmatched bracket is not a tool-call candidate and must not pin the reply.
  const pendingStart = text.lastIndexOf("[");
  const pendingTail =
    pendingStart > text.lastIndexOf("]")
      ? text.slice(pendingStart).replace(/\s+/gu, "").toUpperCase()
      : "";
  let pending =
    pendingTail.length > 0 &&
    LEGACY_BRACKET_OPEN_HEADERS.some((header) => header.startsWith(pendingTail)) &&
    !isInsideCode(pendingStart, codeRegions);
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
    // A later close can complete the hidden payload or the payload test.
    pending ||= !closeMatch;
    if (!isToolPayload) {
      continue;
    }
    result += text.slice(cursor, openStart);
    cursor = closeMatch ? closeMatch.index + closeMatch[0].length : text.length;
    if (cursor === text.length) {
      break;
    }
  }
  return { text: result + text.slice(cursor), pending };
}

export function stripLegacyBracketToolCallBlocks(text: string): string {
  if (!text || !LEGACY_BRACKET_TOOL_BLOCK_QUICK_RE.test(text)) {
    return text;
  }
  return scanLegacyBracketToolCallBlocks(text, findCodeRegions(text)).text;
}

export type RelevantMemoriesScan = {
  text: string;
  inMemoryBlock: boolean;
};

export function scanRelevantMemoriesTags(
  text: string,
  codeRegions?: ReturnType<typeof findCodeRegions>,
): RelevantMemoriesScan {
  if (!text || !MEMORY_TAG_QUICK_RE.test(text)) {
    return { text, inMemoryBlock: false };
  }
  const resolvedCodeRegions = codeRegions ?? findCodeRegions(text);
  MEMORY_TAG_RE.lastIndex = 0;

  let result = "";
  let lastIndex = 0;
  let inMemoryBlock = false;

  for (const match of text.matchAll(MEMORY_TAG_RE)) {
    const idx = match.index;
    if (isInsideCode(idx, resolvedCodeRegions)) {
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

  return { text: result, inMemoryBlock };
}

export function stripRelevantMemoriesTags(text: string): string {
  return scanRelevantMemoriesTags(text).text;
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
