import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import { stripReasoningTagsFromText } from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/**
 * Strip XML-style tool call tags that models sometimes emit as plain text.
 * This stateful pass hides content from an opening tag through the matching
 * closing tag, or to end-of-string if the stream was truncated mid-tag.
 */
const TOOL_CALL_QUICK_RE = /<\s*\/?\s*(?:tool_call|function_calls?|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set(["tool_call", "function_call", "function_calls", "tool_calls"]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;

function endsInsideQuotedString(text: string, start: number, end: number): boolean {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < end; idx += 1) {
    const char = text[idx];
    if (quoteChar === null) {
      if (char === '"' || char === "'") {
        quoteChar = char;
      }
      continue;
    }

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === quoteChar) {
      quoteChar = null;
    }
  }

  return quoteChar !== null;
}

interface ParsedToolCallTag {
  contentStart: number;
  end: number;
  isClose: boolean;
  isSelfClosing: boolean;
  tagName: string;
  isTruncated: boolean;
}

function isToolCallBoundary(char: string | undefined): boolean {
  return !char || /\s/.test(char) || char === "/" || char === ">";
}

function findTagCloseIndex(text: string, start: number): number {
  let quoteChar: "'" | '"' | null = null;
  let isEscaped = false;

  for (let idx = start; idx < text.length; idx += 1) {
    const char = text[idx];
    if (quoteChar !== null) {
      if (isEscaped) {
        isEscaped = false;
        continue;
      }
      if (char === "\\") {
        isEscaped = true;
        continue;
      }
      if (char === quoteChar) {
        quoteChar = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quoteChar = char;
      continue;
    }
    if (char === "<") {
      return -1;
    }
    if (char === ">") {
      return idx;
    }
  }

  return -1;
}

function looksLikeToolCallPayloadStart(text: string, start: number): boolean {
  return TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(start));
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  if (text[start] !== "<") {
    return null;
  }

  let cursor = start + 1;
  while (cursor < text.length && /\s/.test(text[cursor])) {
    cursor += 1;
  }

  let isClose = false;
  if (text[cursor] === "/") {
    isClose = true;
    cursor += 1;
    while (cursor < text.length && /\s/.test(text[cursor])) {
      cursor += 1;
    }
  }

  const nameStart = cursor;
  while (cursor < text.length && /[A-Za-z_]/.test(text[cursor])) {
    cursor += 1;
  }

  const tagName = text.slice(nameStart, cursor).toLowerCase();
  if (!TOOL_CALL_TAG_NAMES.has(tagName) || !isToolCallBoundary(text[cursor])) {
    return null;
  }
  const contentStart = cursor;

  const closeIndex = findTagCloseIndex(text, cursor);
  if (closeIndex === -1) {
    return {
      contentStart,
      end: text.length,
      isClose,
      isSelfClosing: false,
      tagName,
      isTruncated: true,
    };
  }

  return {
    contentStart,
    end: closeIndex + 1,
    isClose,
    isSelfClosing: !isClose && /\/\s*$/.test(text.slice(cursor, closeIndex)),
    tagName,
    isTruncated: false,
  };
}

function stripToolCallXmlTags(text: string): string {
  if (!text || !TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;
  let toolCallContentStart = 0;
  let toolCallBlockTagName: string | null = null;
  const visibleTagBalance = new Map<string, number>();

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    if (!inToolCallBlock && isInsideCode(idx, codeRegions)) {
      continue;
    }

    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }

    if (!inToolCallBlock) {
      result += text.slice(lastIndex, idx);
      if (tag.isClose) {
        if (tag.isTruncated) {
          const preserveEnd = tag.contentStart;
          result += text.slice(idx, preserveEnd);
          lastIndex = preserveEnd;
          idx = Math.max(idx, preserveEnd - 1);
          continue;
        }
        const balance = visibleTagBalance.get(tag.tagName) ?? 0;
        if (balance > 0) {
          result += text.slice(idx, tag.end);
          visibleTagBalance.set(tag.tagName, balance - 1);
        }
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      if (tag.isSelfClosing) {
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      if (
        !tag.isClose &&
        looksLikeToolCallPayloadStart(text, tag.isTruncated ? tag.contentStart : tag.end)
      ) {
        inToolCallBlock = true;
        toolCallContentStart = tag.end;
        toolCallBlockTagName = tag.tagName;
        if (tag.isTruncated) {
          lastIndex = text.length;
          break;
        }
      } else {
        const preserveEnd = tag.isTruncated ? tag.contentStart : tag.end;
        result += text.slice(idx, preserveEnd);
        if (!tag.isTruncated) {
          visibleTagBalance.set(tag.tagName, (visibleTagBalance.get(tag.tagName) ?? 0) + 1);
        }
        lastIndex = preserveEnd;
        idx = Math.max(idx, preserveEnd - 1);
        continue;
      }
    } else if (
      tag.isClose &&
      tag.tagName === toolCallBlockTagName &&
      !endsInsideQuotedString(text, toolCallContentStart, idx)
    ) {
      inToolCallBlock = false;
      toolCallBlockTagName = null;
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  }

  return result;
}

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

export function stripAssistantInternalScaffolding(text: string): string {
  const withoutReasoning = stripReasoningTagsFromText(text, { mode: "preserve", trim: "start" });
  const withoutMemories = stripRelevantMemoriesTags(withoutReasoning);
  const withoutToolCalls = stripToolCallXmlTags(withoutMemories);
  const withoutSpecialTokens = stripModelSpecialTokens(withoutToolCalls);
  return withoutSpecialTokens.trimStart();
}
