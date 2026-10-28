import { expectDefined } from "@openclaw/normalization-core";
import {
  consumeLineBreak,
  skipHorizontalWhitespace,
  skipWhitespace,
} from "../../../packages/tool-call-repair/src/grammar.js";
import { findCodeRegions, isInsideCode } from "./code-ranges.js";
import type { findCodeOwnership } from "./code-regions.js";
import { isGlmArgPayload } from "./glm-arg-key-payload.js";
import { createQuotedStringScanner, parseXmlTagAt, type ParsedToolCallTag } from "./xml-tag-at.js";

export const TOOL_CALL_QUICK_RE =
  /<\s*(?:\/\s*)?(?:(?:antml|mm):)?(?:tool_call|tool_result|function_calls?|function_response|function|tool_calls|invoke|parameter)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function_response",
  "function",
  "tool_calls",
  "invoke",
  "antml:invoke",
  "antml:parameter",
  "antml:function_calls",
  "mm:tool_call",
  "mm:function_calls",
  "mm:invoke",
  "mm:parameter",
]);
const TOOL_CALL_PREFIX_NAMES = [...TOOL_CALL_TAG_NAMES, "parameter", "parameters", "arguments"];
const ATTRIBUTE_NAME = "[A-Za-z_:][-A-Za-z0-9_:.]*";
const ATTRIBUTE_VALUE = String.raw`(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+)`;
const ATTRIBUTES = String.raw`(?:\s+${ATTRIBUTE_NAME}\s*=\s*${ATTRIBUTE_VALUE})*`;
const TOOL_CALL_JSON_PAYLOAD_START_RE = new RegExp(String.raw`^${ATTRIBUTES}\s*[[{]`);
// The same attribute grammar, with its final name/value allowed to be incomplete.
const TOOL_CALL_JSON_PAYLOAD_PREFIX_RE = new RegExp(
  String.raw`^${ATTRIBUTES}(?:\s+${ATTRIBUTE_NAME}(?:\s*=(?:\s*(?:"[^"]*|'[^']*|[^\s"'=<>\x60]+))?)?)?\s*$`,
);
const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:antml:|mm:)?(?:function_call|tool_call|function|invoke|parameters?|arguments?)\b/i;
const NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE = /^\s*(?:\r?\n\s*)?<(?:function_call|tool_call)\b/i;

type ToolCallPayloadKind = "json" | "xml" | null;
export type ToolCallXmlProjection = {
  appendSafe: boolean;
  resolveCodeOwnership: typeof findCodeOwnership;
  // With no code markers, only the delimiter boundary is needed for the next append.
  parameterText?: string;
  parameterOwnership?: ReturnType<typeof findCodeOwnership>;
};

export function isToolCallTagPrefix(text: string, start: number): boolean {
  if (start < 0) {
    return false;
  }
  const match = /^<\s*(?:\/\s*)?([\w:]*)$/.exec(text.slice(start));
  if (!match) {
    return false;
  }
  const name = (match[1] ?? "").toLowerCase();
  return TOOL_CALL_PREFIX_NAMES.some((candidate) => candidate.startsWith(name));
}

function detectToolCallPayloadKind(
  text: string,
  start: number,
  streaming = false,
): ToolCallPayloadKind {
  const rest = text.slice(start);
  if (TOOL_CALL_JSON_PAYLOAD_START_RE.test(rest)) {
    return "json";
  }
  if (
    TOOL_CALL_XML_PAYLOAD_START_RE.test(rest) ||
    (streaming && isToolCallTagPrefix(text, skipWhitespace(text, start)))
  ) {
    return "xml";
  }
  if (isGlmArgPayload(rest, streaming)) {
    return "xml";
  }
  return null;
}

function startsWithNestedJsonToolCallPayload(text: string, start: number): boolean {
  if (!NESTED_JSON_TOOL_CALL_PAYLOAD_START_RE.test(text.slice(start))) {
    return false;
  }
  const nestedTag = parseToolCallTagAt(text, skipWhitespace(text, start));
  if (
    !nestedTag ||
    nestedTag.isClose ||
    nestedTag.isSelfClosing ||
    nestedTag.isTruncated ||
    (nestedTag.tagName !== "function_call" && nestedTag.tagName !== "tool_call")
  ) {
    return false;
  }
  return TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(nestedTag.end));
}

function isLikelyStandaloneFunctionToolCall(
  text: string,
  tagStart: number,
  tag: ParsedToolCallTag,
): boolean {
  if (tag.isClose || tag.isSelfClosing || tag.isTruncated) {
    return false;
  }

  if (tag.tagName === "function" && !/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }

  let idx = tagStart - 1;
  while (idx >= 0 && (text[idx] === " " || text[idx] === "\t")) {
    idx -= 1;
  }

  return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text.charAt(idx));
}

function isAdjacentToStrippedToolCallBlock(
  text: string,
  tagStart: number,
  lastStrippedBlockEnd: number | null,
): boolean {
  if (lastStrippedBlockEnd === null || lastStrippedBlockEnd > tagStart) {
    return false;
  }
  for (let idx = lastStrippedBlockEnd; idx < tagStart; idx += 1) {
    if (text[idx] !== " " && text[idx] !== "\t" && text[idx] !== "\n" && text[idx] !== "\r") {
      return false;
    }
  }
  return true;
}

function findMatchingToolCallCloseIndex(text: string, start: number, tagName: string): number {
  for (let idx = start; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    const tag = parseToolCallTagAt(text, idx);
    if (!tag) {
      continue;
    }
    if (tag.isClose && tag.tagName === tagName && !tag.isTruncated) {
      return idx;
    }
    idx = Math.max(idx, tag.end - 1);
  }
  return -1;
}

function findAdjacentOpeningToolCallTag(
  text: string,
  start: number,
  tagName: string,
): ParsedToolCallTag | null {
  const tag = parseToolCallTagAt(text, skipWhitespace(text, start));
  if (!tag || tag.isClose || tag.tagName !== tagName) {
    return null;
  }
  return tag;
}

function parseToolCallTagAt(text: string, start: number): ParsedToolCallTag | null {
  const tag = parseXmlTagAt(text, start);
  return tag && TOOL_CALL_TAG_NAMES.has(tag.tagName) ? tag : null;
}

function scanXmlTags(
  text: string,
  codeRegions: ReturnType<typeof findCodeRegions>,
  projection?: ToolCallXmlProjection,
) {
  type Tag = ParsedToolCallTag & { start: number; hasMatchingClose: boolean };
  const tags: Tag[] = [];
  const openTags = new Map<string, Tag[]>();
  for (let start = text.indexOf("<"); start !== -1; start = text.indexOf("<", start + 1)) {
    if (isInsideCode(start, codeRegions)) {
      continue;
    }
    const parsed = parseXmlTagAt(text, start);
    if (!parsed || parsed.isTruncated) {
      if (projection && (parsed?.isTruncated || isToolCallTagPrefix(text, start))) {
        projection.appendSafe = false;
      }
      continue;
    }
    const tag: Tag = { ...parsed, start, hasMatchingClose: false };
    tags.push(tag);
    const parents = openTags.get(tag.tagName);
    if (tag.isClose) {
      const opening = parents?.pop();
      if (opening) {
        opening.hasMatchingClose = true;
      }
    } else if (!tag.isSelfClosing) {
      if (parents) {
        parents.push(tag);
      } else {
        openTags.set(tag.tagName, [tag]);
      }
    }
    start = tag.end - 1;
  }
  return tags;
}

function isDanglingFunctionParameterParent(text: string, tag: ParsedToolCallTag): boolean {
  if (tag.tagName !== "function" || !/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }
  const nextTag = parseXmlTagAt(text, skipWhitespace(text, tag.end));
  return nextTag?.tagName === "parameter" && !nextTag.isClose;
}

function trimImmediateLineBreakBefore(text: string, start: number, end: number): number {
  if (end > start && text[end - 1] === "\n") {
    return end - (end - 2 >= start && text[end - 2] === "\r" ? 2 : 1);
  }
  return end > start && text[end - 1] === "\r" ? end - 1 : end;
}

function isLineStartAt(text: string, start: number): boolean {
  let cursor = start - 1;
  while (cursor >= 0 && (text[cursor] === " " || text[cursor] === "\t")) {
    cursor -= 1;
  }
  return cursor < 0 || text[cursor] === "\n" || text[cursor] === "\r";
}

function isLineEndAfter(text: string, end: number): boolean {
  const cursor = skipHorizontalWhitespace(text, end);
  return cursor >= text.length || text[cursor] === "\n" || text[cursor] === "\r";
}

function unwrapStandaloneParameterTags(text: string, projection?: ToolCallXmlProjection): string {
  if (!/<\s*\/?\s*parameter\b/i.test(text)) {
    if (projection && isToolCallTagPrefix(text, text.lastIndexOf("<"))) {
      projection.appendSafe = false;
    }
    return text;
  }

  const ownership =
    projection && /[`~\t]| {4}/u.test(text) ? projection.resolveCodeOwnership(text) : undefined;
  const codeRegions = projection ? (ownership?.regions ?? []) : findCodeRegions(text);
  if (projection) {
    // XML removal can create Markdown syntax absent from the original source.
    projection.parameterText = ownership ? text : text.slice(-4);
    projection.parameterOwnership = ownership;
  }
  const openTags: Array<{ name: string; unwrap: boolean; trimBoundaryLineBreaks: boolean }> = [];
  let result = "";
  let lastIndex = 0;

  for (const tag of scanXmlTags(text, codeRegions, projection)) {
    const idx = tag.start;

    if (tag.isClose) {
      const openIndex = openTags.findLastIndex((entry) => entry.name === tag.tagName);
      if (openIndex !== -1) {
        const opening = expectDefined(openTags[openIndex], "open tags entry at open index");
        if (opening.unwrap) {
          if (projection && skipHorizontalWhitespace(text, tag.end) === text.length) {
            projection.appendSafe = false;
          }
          const contentEnd =
            opening.trimBoundaryLineBreaks &&
            isLineStartAt(text, idx) &&
            isLineEndAfter(text, tag.end)
              ? trimImmediateLineBreakBefore(text, lastIndex, idx)
              : idx;
          result += text.slice(lastIndex, contentEnd);
          lastIndex = tag.end;
        }
        openTags.splice(openIndex);
      }
    } else if (tag.isSelfClosing) {
      if (tag.tagName === "parameter" && openTags.length === 0) {
        result += text.slice(lastIndex, idx);
        lastIndex = tag.end;
      }
    } else if (tag.hasMatchingClose || isDanglingFunctionParameterParent(text, tag)) {
      const unwrap = tag.tagName === "parameter" && openTags.length === 0;
      let trimBoundaryLineBreaks = false;
      if (unwrap) {
        result += text.slice(lastIndex, idx);
        lastIndex = tag.end;
        const contentStart = isLineStartAt(text, idx) ? consumeLineBreak(text, lastIndex) : null;
        if (contentStart !== null) {
          lastIndex = contentStart;
          trimBoundaryLineBreaks = true;
        }
      }
      openTags.push({ name: tag.tagName, unwrap, trimBoundaryLineBreaks });
    }
  }

  return result + text.slice(lastIndex);
}

export type StripToolCallXmlOptions = {
  stripFunctionCallsXmlPayloads?: boolean;
  stripFunctionResponseAfterPluralToolCalls?: boolean;
};

export function stripToolCallXmlTags(input: string, options: StripToolCallXmlOptions = {}): string {
  return stripToolCallXmlTagsInternal(input, options, false);
}

export function stripToolCallXmlTagsInternal(
  text: string,
  options: StripToolCallXmlOptions,
  streaming: boolean,
  resolveCodeRegions = findCodeRegions,
  projection?: ToolCallXmlProjection,
): string {
  if (
    !text ||
    (!TOOL_CALL_QUICK_RE.test(text) &&
      !(streaming && isToolCallTagPrefix(text, text.lastIndexOf("<"))))
  ) {
    if (projection && isToolCallTagPrefix(text, text.lastIndexOf("<"))) {
      projection.appendSafe = false;
    }
    return text;
  }
  const codeRegions = resolveCodeRegions(text);
  // A lone transport opener is scaffolding unless Markdown owns it as code.
  if (/^\s*<tool_call>\s*$/i.test(text) && !isInsideCode(text.indexOf("<"), codeRegions)) {
    if (projection) {
      projection.appendSafe = false;
    }
    return "";
  }

  let result = "";
  let lastIndex = 0;
  let isInsidePayloadQuote: ((end: number) => boolean) | undefined;
  let toolCallBlockStart = 0;
  let toolCallBlockTagName: string | null = null;
  let lastStrippedToolCallBlockEnd: number | null = null;
  const visibleTagBalance = new Map<string, number>();

  for (let idx = 0; idx < text.length; idx += 1) {
    if (text[idx] !== "<") {
      continue;
    }
    if (toolCallBlockTagName === null && isInsideCode(idx, codeRegions)) {
      continue;
    }

    const tag = parseToolCallTagAt(text, idx);
    if (projection && (tag?.isTruncated || isToolCallTagPrefix(text, idx))) {
      projection.appendSafe = false;
    }
    if (
      streaming &&
      toolCallBlockTagName === null &&
      ((tag?.isTruncated && !tag.isClose) || isToolCallTagPrefix(text, idx))
    ) {
      if (projection) {
        projection.appendSafe = false;
      }
      return unwrapStandaloneParameterTags(result + text.slice(lastIndex, idx), projection);
    }
    if (!tag) {
      continue;
    }

    if (toolCallBlockTagName === null) {
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
        lastStrippedToolCallBlockEnd = tag.end;
        lastIndex = tag.end;
        idx = Math.max(idx, tag.end - 1);
        continue;
      }
      const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
      const isPluralToolCallWrapper =
        tag.tagName.endsWith("function_calls") || tag.tagName === "tool_calls";
      const matchingCloseStart = isPluralToolCallWrapper
        ? findMatchingToolCallCloseIndex(text, tag.end, tag.tagName)
        : -1;
      const matchingCloseTag =
        matchingCloseStart === -1 ? null : parseToolCallTagAt(text, matchingCloseStart);
      const shouldStripPluralWrapperBeforeResponse =
        options.stripFunctionResponseAfterPluralToolCalls === true &&
        isPluralToolCallWrapper &&
        matchingCloseTag !== null &&
        findAdjacentOpeningToolCallTag(text, matchingCloseTag.end, "function_response") !== null;
      const shouldDetectXmlPayload =
        tag.tagName === "tool_call" ||
        tag.tagName === "mm:tool_call" ||
        tag.tagName === "function" ||
        tag.tagName.endsWith("invoke") ||
        ((tag.tagName.includes(":") ||
          isLineStartAt(text, idx) ||
          options.stripFunctionCallsXmlPayloads === true ||
          shouldStripPluralWrapperBeforeResponse) &&
          isPluralToolCallWrapper);
      const payloadKind = shouldDetectXmlPayload
        ? detectToolCallPayloadKind(text, payloadStart, streaming)
        : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart))
          ? "json"
          : null;
      const shouldStripStandaloneFunction =
        (tag.tagName !== "function" && tag.tagName !== "invoke") ||
        isLikelyStandaloneFunctionToolCall(text, idx, tag);
      const functionResponseCloseStart =
        tag.tagName === "function_response"
          ? findMatchingToolCallCloseIndex(text, tag.end, tag.tagName)
          : -1;
      const shouldStripStandaloneResult =
        tag.tagName === "function_response" &&
        ((isLineStartAt(text, idx) && isLineEndAfter(text, tag.end)) ||
          isAdjacentToStrippedToolCallBlock(text, idx, lastStrippedToolCallBlockEnd) ||
          (functionResponseCloseStart !== -1 &&
            isLineStartAt(result, result.length) &&
            isLineEndAfter(text, tag.end)));
      if ((payloadKind && shouldStripStandaloneFunction) || shouldStripStandaloneResult) {
        isInsidePayloadQuote =
          payloadKind === "json" ||
          (payloadKind === "xml" && startsWithNestedJsonToolCallPayload(text, payloadStart))
            ? createQuotedStringScanner(text, tag.end)
            : undefined;
        toolCallBlockStart = idx;
        toolCallBlockTagName = tag.tagName;
        if (tag.isTruncated) {
          lastIndex = text.length;
          break;
        }
      } else {
        if (projection && TOOL_CALL_JSON_PAYLOAD_PREFIX_RE.test(text.slice(payloadStart))) {
          projection.appendSafe = false;
        }
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
      (tag.tagName === toolCallBlockTagName ||
        (toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call")) &&
      !isInsidePayloadQuote?.(idx)
    ) {
      isInsidePayloadQuote = undefined;
      toolCallBlockTagName = null;
      lastStrippedToolCallBlockEnd = tag.end;
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (projection && toolCallBlockTagName !== null) {
    projection.appendSafe = false;
  }
  if (toolCallBlockTagName === null) {
    result += text.slice(lastIndex);
  } else if (toolCallBlockTagName === "function") {
    result += text.slice(toolCallBlockStart);
  }

  return unwrapStandaloneParameterTags(result, projection);
}
