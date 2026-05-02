import { normalizeLowercaseStringOrEmpty } from "../string-coerce.js";
import { findCodeRegions, isInsideCode } from "./code-regions.js";
import { stripModelSpecialTokens } from "./model-special-tokens.js";
import {
  stripReasoningTagsFromText,
  type ReasoningTagMode,
  type ReasoningTagTrim,
} from "./reasoning-tags.js";

const MEMORY_TAG_RE = /<\s*(\/?)\s*relevant[-_]memories\b[^<>]*>/gi;
const MEMORY_TAG_QUICK_RE = /<\s*\/?\s*relevant[-_]memories\b/i;

/**
 * Strip XML-style tool call tags that models sometimes emit as plain text.
 * This stateful pass hides content from an opening tag through the matching
 * closing tag, or to end-of-string if the stream was truncated mid-tag.
 */
const TOOL_CALL_QUICK_RE =
  /<\s*\/?\s*(?:tool_call|tool_result|function_calls?|function|tool_calls)\b/i;
const TOOL_CALL_TAG_NAMES = new Set([
  "tool_call",
  "tool_result",
  "function_call",
  "function_calls",
  "function",
  "tool_calls",
]);
const TOOL_CALL_JSON_PAYLOAD_START_RE =
  /^(?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))*\s*(?:\r?\n\s*)?[[{]/;
const TOOL_CALL_XML_PAYLOAD_START_RE =
  /^\s*(?:\r?\n\s*)?<(?:function|invoke|parameters?|arguments?)\b/i;

type ToolCallPayloadKind = "json" | "xml" | null;

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

function detectToolCallPayloadKind(text: string, start: number): ToolCallPayloadKind {
  const rest = text.slice(start);
  if (TOOL_CALL_JSON_PAYLOAD_START_RE.test(rest)) {
    return "json";
  }
  if (TOOL_CALL_XML_PAYLOAD_START_RE.test(rest)) {
    return "xml";
  }
  return null;
}

function isLikelyStandaloneFunctionToolCall(
  text: string,
  tagStart: number,
  tag: ParsedToolCallTag,
): boolean {
  if (tag.tagName !== "function" || tag.isClose || tag.isSelfClosing || tag.isTruncated) {
    return false;
  }

  if (!/\bname\s*=/.test(text.slice(tag.contentStart, tag.end))) {
    return false;
  }

  let idx = tagStart - 1;
  while (idx >= 0 && (text[idx] === " " || text[idx] === "\t")) {
    idx -= 1;
  }

  return idx < 0 || text[idx] === "\n" || text[idx] === "\r" || /[.!?:]/.test(text[idx]);
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

  const tagName = normalizeLowercaseStringOrEmpty(text.slice(nameStart, cursor));
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

export function stripToolCallXmlTags(text: string): string {
  if (!text || !TOOL_CALL_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);
  let result = "";
  let lastIndex = 0;
  let inToolCallBlock = false;
  let toolCallBlockContentStart = 0;
  let toolCallBlockNeedsQuoteBalance = false;
  let toolCallBlockStart = 0;
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
      const payloadStart = tag.isTruncated ? tag.contentStart : tag.end;
      const payloadKind =
        tag.tagName === "tool_call" || tag.tagName === "function"
          ? detectToolCallPayloadKind(text, payloadStart)
          : TOOL_CALL_JSON_PAYLOAD_START_RE.test(text.slice(payloadStart))
            ? "json"
            : null;
      const shouldStripStandaloneFunction =
        tag.tagName !== "function" || isLikelyStandaloneFunctionToolCall(text, idx, tag);
      if (!tag.isClose && payloadKind && shouldStripStandaloneFunction) {
        inToolCallBlock = true;
        toolCallBlockContentStart = tag.end;
        toolCallBlockNeedsQuoteBalance = payloadKind === "json";
        toolCallBlockStart = idx;
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
      (tag.tagName === toolCallBlockTagName ||
        (toolCallBlockTagName === "tool_result" && tag.tagName === "tool_call")) &&
      (!toolCallBlockNeedsQuoteBalance ||
        !endsInsideQuotedString(text, toolCallBlockContentStart, idx))
    ) {
      inToolCallBlock = false;
      toolCallBlockNeedsQuoteBalance = false;
      toolCallBlockTagName = null;
    }

    lastIndex = tag.end;
    idx = Math.max(idx, tag.end - 1);
  }

  if (!inToolCallBlock) {
    result += text.slice(lastIndex);
  } else if (toolCallBlockTagName === "function") {
    result += text.slice(toolCallBlockStart);
  }

  return result;
}

/**
 * Strip malformed Minimax tool invocations that leak into text content.
 * Minimax sometimes embeds tool calls as XML in text blocks instead of
 * proper structured tool calls.
 */
export function stripMinimaxToolCallXml(text: string): string {
  if (!text || !/minimax:tool_call/i.test(text)) {
    return text;
  }

  // Remove <invoke ...>...</invoke> blocks (non-greedy to handle multiple).
  let cleaned = text.replace(/<invoke\b[^>]*>[\s\S]*?<\/invoke>/gi, "");

  // Remove stray minimax tool tags.
  cleaned = cleaned.replace(/<\/?minimax:tool_call>/gi, "");

  return cleaned;
}

/**
 * Strip downgraded tool call text representations that leak into user-visible
 * text content when replaying history across providers.
 */
export function stripDowngradedToolCallText(text: string): string {
  if (!text) {
    return text;
  }
  if (!/\[Tool (?:Call|Result)/i.test(text) && !/\[Historical context/i.test(text)) {
    return text;
  }

  const consumeJsonish = (
    input: string,
    start: number,
    options?: { allowLeadingNewlines?: boolean },
  ): number | null => {
    const { allowLeadingNewlines = false } = options ?? {};
    let index = start;
    while (index < input.length) {
      const ch = input[index];
      if (ch === " " || ch === "\t") {
        index += 1;
        continue;
      }
      if (allowLeadingNewlines && (ch === "\n" || ch === "\r")) {
        index += 1;
        continue;
      }
      break;
    }
    if (index >= input.length) {
      return null;
    }

    const startChar = input[index];
    if (startChar === "{" || startChar === "[") {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let idx = index; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === "\\") {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "{" || ch === "[") {
          depth += 1;
        } else if (ch === "}" || ch === "]") {
          depth -= 1;
          if (depth === 0) {
            return idx + 1;
          }
        }
      }
      return null;
    }

    if (startChar === '"') {
      let escape = false;
      for (let idx = index + 1; idx < input.length; idx += 1) {
        const ch = input[idx];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          return idx + 1;
        }
      }
      return null;
    }

    let end = index;
    while (end < input.length && input[end] !== "\n" && input[end] !== "\r") {
      end += 1;
    }
    return end;
  };

  const stripToolCalls = (input: string): string => {
    const toolCallRe = /\[Tool Call:[^\]]*\]/gi;
    let result = "";
    let cursor = 0;
    for (const match of input.matchAll(toolCallRe)) {
      const start = match.index ?? 0;
      if (start < cursor) {
        continue;
      }
      result += input.slice(cursor, start);
      let index = start + match[0].length;
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (input[index] === "\r") {
        index += 1;
        if (input[index] === "\n") {
          index += 1;
        }
      } else if (input[index] === "\n") {
        index += 1;
      }
      while (index < input.length && (input[index] === " " || input[index] === "\t")) {
        index += 1;
      }
      if (normalizeLowercaseStringOrEmpty(input.slice(index, index + 9)) === "arguments") {
        index += 9;
        if (input[index] === ":") {
          index += 1;
        }
        if (input[index] === " ") {
          index += 1;
        }
        const end = consumeJsonish(input, index, { allowLeadingNewlines: true });
        if (end !== null) {
          index = end;
        }
      }
      if (
        (input[index] === "\n" || input[index] === "\r") &&
        (result.endsWith("\n") || result.endsWith("\r") || result.length === 0)
      ) {
        if (input[index] === "\r") {
          index += 1;
        }
        if (input[index] === "\n") {
          index += 1;
        }
      }
      cursor = index;
    }
    result += input.slice(cursor);
    return result;
  };

  // Remove [Tool Call: name (ID: ...)] blocks and their Arguments.
  let cleaned = stripToolCalls(text);

  // Remove [Tool Result for ID ...] blocks and their content.
  cleaned = cleaned.replace(/\[Tool Result for ID[^\]]*\]\n?[\s\S]*?(?=\n*\[Tool |\n*$)/gi, "");

  // Remove [Historical context: ...] markers (self-contained within brackets).
  cleaned = cleaned.replace(/\[Historical context:[^\]]*\]\n?/gi, "");

  return cleaned.trim();
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

// ---------------------------------------------------------------------------
// Leaked reasoning preamble detector
// ---------------------------------------------------------------------------

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/u;
const SUSPICIOUS_PREAMBLE_QUICK_RE =
  /<\s*final\b|<\s*think\b|\b(?:let me|i need to|need to|i should|i'm going to|i am going to|now i|supporting evidence|root cause|the user|sophie[, ]|cybera[, ]|shodan[, ]|for the record)\b|[\u3400-\u9fff\uf900-\ufaff]/iu;
const SUSPICIOUS_LINE_RE =
  /^\s*(?:[-*]\s+)?(?:let me\b|i need to\b|i should\b|i'm going to\b|i am going to\b|need to\b|sophie[, :]?\b|cybera[, :]?\b|shodan[, :]?\b|for the record\b|now i\b|supporting evidence\b|root cause\b)/iu;

function stripCodeForScoring(text: string): string {
  const codeRegions = findCodeRegions(text);
  if (codeRegions.length === 0) {
    return text;
  }
  let result = "";
  let lastIndex = 0;
  for (const region of codeRegions) {
    result += text.slice(lastIndex, region.start);
    lastIndex = region.end;
  }
  result += text.slice(lastIndex);
  return result;
}

function scoreSuspiciousPreamble(text: string): number {
  const scorableText = stripCodeForScoring(text);
  if (!scorableText.trim()) {
    return 0;
  }
  let score = 0;
  if (/<\s*think\b|<\s*final\b|chain[- ]of[- ]thought|internal reasoning/iu.test(scorableText)) {
    score += 3;
  }
  const lines = scorableText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8);
  let suspiciousLineCount = 0;
  for (const line of lines) {
    if (SUSPICIOUS_LINE_RE.test(line)) {
      suspiciousLineCount += 1;
      score += 1;
    }
  }
  if (CJK_RE.test(scorableText)) {
    // Only apply +2 CJK bonus with stronger evidence (≥2 suspicious lines)
    // to avoid truncating valid bilingual content with single instructional lines
    score += suspiciousLineCount >= 2 ? 2 : 1;
  }
  if (suspiciousLineCount >= 2) {
    score += 1;
  }
  return score;
}

function looksUserFacingStart(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith("```") || /^<\s*(think|final)\b/i.test(trimmed)) {
    return false;
  }
  const firstLine = trimmed.split("\n", 1)[0] ?? "";
  if (SUSPICIOUS_LINE_RE.test(firstLine)) {
    return false;
  }
  return true;
}

function hasFencedCode(text: string): boolean {
  return /^\s*(?:```|~~~)/m.test(text);
}

function stripLeakedReasoningPreamble(text: string): string {
  if (!text || !SUSPICIOUS_PREAMBLE_QUICK_RE.test(text)) {
    return text;
  }

  const codeRegions = findCodeRegions(text);

  const paragraphBreakRe = /\n{2,}/g;
  let paragraphMatch: RegExpExecArray | null;
  let paragraphCount = 0;
  while ((paragraphMatch = paragraphBreakRe.exec(text)) !== null && paragraphCount < 4) {
    const splitIndex = paragraphMatch.index + paragraphMatch[0].length;
    if (isInsideCode(splitIndex, codeRegions)) {
      continue;
    }
    const prefix = text.slice(0, paragraphMatch.index).trim();
    const suffix = text.slice(splitIndex).trimStart();
    if (!prefix || !suffix) {
      continue;
    }
    paragraphCount += 1;
    if (hasFencedCode(prefix)) {
      continue;
    }
    if (scoreSuspiciousPreamble(prefix) >= 3 && looksUserFacingStart(suffix)) {
      return suffix;
    }
  }

  const lineBreakRe = /\n/g;
  let lineMatch: RegExpExecArray | null;
  let lineCount = 0;
  while ((lineMatch = lineBreakRe.exec(text)) !== null && lineCount < 6) {
    const splitIndex = lineMatch.index + lineMatch[0].length;
    if (isInsideCode(splitIndex, codeRegions)) {
      continue;
    }
    const prefix = text.slice(0, lineMatch.index);
    const suffix = text.slice(splitIndex).trimStart();
    if (!prefix.trim() || !suffix) {
      continue;
    }
    lineCount += 1;
    if (hasFencedCode(prefix)) {
      continue;
    }
    if (scoreSuspiciousPreamble(prefix) >= 3 && looksUserFacingStart(suffix)) {
      return suffix;
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Structural contamination detector
// ---------------------------------------------------------------------------

// Match leaked metadata envelopes: handles fenced schema blocks with optional trailing debris.
// Requires a ```json fence to avoid stripping unfenced JSON in normal replies.
// The trailing ```debris``` alternative handles leaked metadata that appears as an adjacent
// fenced block. Note: {json} separator lines between objects are a known gap (very rare)
// and would require a more complex multi-block pattern.
const CONTAM_ENVELOPE_RE =
  /(?:Conversation info[^\n]*\n)?```json[\s\S]*?"schema"[\s\S]*?```(?:[\s\S]*?```[^\n]*```)?/gs;
const CONTAM_CSS_RE =
  /(?:^|\n)\s*(?:[\w.-]+\s*\{\s*)?(?:[a-z-]+\s*:\s*[^;]+;\s*){2,}(?:\}\s*)?(?:\n|$)/gm;
const CONTAM_FENCE_RE = /```\s*```/g;
// Match leaked method-call debris: lines starting with .methodName(...)
// This catches leaked internal output like .copyOf(randID)); but won't match
// legitimate code that starts with a variable name (e.g. client.send(...)).
const CONTAM_CODE_DEBRIS_RE = /(?:^|\n)\s*\.\w+\([^)]*\)\)?;?/gm;
// Footer scrubber: match trigger line + subsequent short lines without sentence-end punctuation
// Bounded to avoid eating legitimate reply content after footer-like phrases
const CONTAM_FOOTER_RE =
  /(?:^|\n)(?:Copyright ©|Powered by|Manage your notification settings)[^\n]*(?:\n(?![A-Z][^\n]*[.!?]["']?\s*$)[^\n]{0,80})*/gim;

function isInsideCodeAt(offset: number, length: number, text: string): boolean {
  const codeRegions = findCodeRegions(text);
  for (const region of codeRegions) {
    if (offset < region.end && offset + length > region.start) {
      return true;
    }
  }
  return false;
}

function stripStructuralContamination(text: string): string {
  if (!text || text.length < 50) {
    return text;
  }

  // Always strip envelope matches (they're always contamination, never legitimate code)
  let result = text.replace(CONTAM_ENVELOPE_RE, "");

  // Recompute code regions after each mutation to avoid stale offsets
  result = result.replace(CONTAM_CSS_RE, (match, offset) => {
    if (isInsideCodeAt(offset, match.length, result)) {
      return match;
    }
    return "";
  });
  result = result.replace(CONTAM_FENCE_RE, (match, offset) => {
    // Recompute regions after CSS removal
    if (isInsideCodeAt(offset, match.length, result)) {
      return match;
    }
    return "";
  });
  result = result.replace(CONTAM_CODE_DEBRIS_RE, (match, offset) => {
    // Recompute regions after fence removal
    if (isInsideCodeAt(offset, match.length, result)) {
      return match;
    }
    return "";
  });
  result = result.replace(CONTAM_FOOTER_RE, (match, offset) => {
    // Recompute regions after debris removal
    if (isInsideCodeAt(offset, match.length, result)) {
      return match;
    }
    return "";
  });
  return result.trim();
}

export { stripStructuralContamination };

export type AssistantVisibleTextSanitizerProfile = "delivery" | "history" | "internal-scaffolding";

type AssistantVisibleTextPipelineOptions = {
  finalTrim: ReasoningTagTrim;
  preserveDowngradedToolText?: boolean;
  preserveMinimaxToolXml?: boolean;
  reasoningMode: ReasoningTagMode;
  reasoningTrim: ReasoningTagTrim;
  stageOrder: "reasoning-first" | "reasoning-last";
  stripLeakedPreamble?: boolean;
  stripStructuralContamination?: boolean;
};

const ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS: Record<
  AssistantVisibleTextSanitizerProfile,
  AssistantVisibleTextPipelineOptions
> = {
  delivery: {
    finalTrim: "both",
    reasoningMode: "strict",
    reasoningTrim: "both",
    stageOrder: "reasoning-last",
    stripLeakedPreamble: true,
    stripStructuralContamination: true,
  },
  history: {
    finalTrim: "none",
    reasoningMode: "strict",
    reasoningTrim: "none",
    stageOrder: "reasoning-last",
  },
  "internal-scaffolding": {
    finalTrim: "start",
    preserveDowngradedToolText: true,
    preserveMinimaxToolXml: true,
    reasoningMode: "preserve",
    reasoningTrim: "start",
    stageOrder: "reasoning-first",
    stripLeakedPreamble: false,
    stripStructuralContamination: false,
  },
};

function applyAssistantVisibleTextStagePipeline(
  text: string,
  options: AssistantVisibleTextPipelineOptions,
): string {
  if (!text) {
    return text;
  }

  const stripReasoning = (value: string) =>
    stripReasoningTagsFromText(value, {
      mode: options.reasoningMode,
      trim: options.reasoningTrim,
    });
  const applyFinalTrim = (value: string) => {
    if (options.finalTrim === "none") {
      return value;
    }
    if (options.finalTrim === "start") {
      return value.trimStart();
    }
    return value.trim();
  };
  const stripNonReasoningStages = (value: string) => {
    let cleaned = value;
    if (!options.preserveMinimaxToolXml) {
      cleaned = stripMinimaxToolCallXml(cleaned);
    }
    cleaned = stripModelSpecialTokens(cleaned);
    cleaned = stripRelevantMemoriesTags(cleaned);
    cleaned = stripToolCallXmlTags(cleaned);
    if (!options.preserveDowngradedToolText) {
      cleaned = stripDowngradedToolCallText(cleaned);
    }
    return cleaned;
  };

  let result: string;
  if (options.stageOrder === "reasoning-first") {
    result = stripNonReasoningStages(stripReasoning(text));
  } else {
    result = stripReasoning(stripNonReasoningStages(text));
  }

  if (options.stripLeakedPreamble) {
    result = stripLeakedReasoningPreamble(result);
  }
  if (options.stripStructuralContamination) {
    result = stripStructuralContamination(result);
  }

  return applyFinalTrim(result);
}

export function sanitizeAssistantVisibleTextWithProfile(
  text: string,
  profile: AssistantVisibleTextSanitizerProfile = "delivery",
): string {
  return applyAssistantVisibleTextStagePipeline(
    text,
    ASSISTANT_VISIBLE_TEXT_PIPELINE_OPTIONS[profile],
  );
}

export function stripAssistantInternalScaffolding(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "internal-scaffolding");
}

/**
 * Canonical user-visible assistant text sanitizer for delivery and history
 * extraction paths. Keeps prose, removes internal scaffolding.
 */
export function sanitizeAssistantVisibleText(text: string): string {
  return sanitizeAssistantVisibleTextWithProfile(text, "delivery");
}

/**
 * Backwards-compatible trim wrapper.
 * Prefer sanitizeAssistantVisibleTextWithProfile for new call sites.
 */
export function sanitizeAssistantVisibleTextWithOptions(
  text: string,
  options?: { trim?: "none" | "both" },
): string {
  const profile = options?.trim === "none" ? "history" : "delivery";
  return sanitizeAssistantVisibleTextWithProfile(text, profile);
}
