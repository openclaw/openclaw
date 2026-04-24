// Utilities for splitting outbound text into platform-sized chunks without
// unintentionally breaking on newlines. Using [\s\S] keeps newlines inside
// the chunk so messages are only split when they truly exceed the limit.

import type { ChannelId } from "../channels/plugins/types.core.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  findBlockquoteAt,
  parseBlockquoteSpans,
  reapplyBlockquotePrefix,
} from "../markdown/blockquotes.js";
import { findFenceSpanAt, isSafeFenceBreak, parseFenceSpans } from "../markdown/fences.js";
import {
  buildInlineClose,
  buildInlineReopen,
  scanUnmatchedInlineMarkers,
} from "../markdown/inline-formatting.js";
import { findTableSpanAt, isSafeTableBreak, parseTableSpans } from "../markdown/table-spans.js";
import { resolveChannelStreamingChunkMode } from "../plugin-sdk/channel-streaming.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { chunkTextByBreakResolver } from "../shared/text-chunking.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

export type TextChunkProvider = ChannelId;

/**
 * Chunking mode for outbound messages:
 * - "length": Split only when exceeding textChunkLimit (default)
 * - "newline": Prefer breaking on "soft" boundaries. Historically this split on every
 *   newline; now it only breaks on paragraph boundaries (blank lines) unless the text
 *   exceeds the length limit.
 */
export type ChunkMode = "length" | "newline";

const DEFAULT_CHUNK_LIMIT = 4000;
const DEFAULT_CHUNK_MODE: ChunkMode = "length";

type ProviderChunkConfig = {
  textChunkLimit?: number;
  chunkMode?: ChunkMode;
  streaming?: unknown;
  accounts?: Record<
    string,
    { textChunkLimit?: number; chunkMode?: ChunkMode; streaming?: unknown }
  >;
};

function resolveChunkLimitForProvider(
  cfgSection: ProviderChunkConfig | undefined,
  accountId?: string | null,
): number | undefined {
  if (!cfgSection) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = cfgSection.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = resolveAccountEntry(accounts, normalizedAccountId);
    if (typeof direct?.textChunkLimit === "number") {
      return direct.textChunkLimit;
    }
  }
  return cfgSection.textChunkLimit;
}

export function resolveTextChunkLimit(
  cfg: OpenClawConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
  opts?: { fallbackLimit?: number },
): number {
  const fallback =
    typeof opts?.fallbackLimit === "number" && opts.fallbackLimit > 0
      ? opts.fallbackLimit
      : DEFAULT_CHUNK_LIMIT;
  const providerOverride = (() => {
    if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) {
      return undefined;
    }
    const channelsConfig = cfg?.channels as Record<string, unknown> | undefined;
    const providerConfig = (channelsConfig?.[provider] ??
      (cfg as Record<string, unknown> | undefined)?.[provider]) as ProviderChunkConfig | undefined;
    return resolveChunkLimitForProvider(providerConfig, accountId);
  })();
  if (typeof providerOverride === "number" && providerOverride > 0) {
    return providerOverride;
  }
  return fallback;
}

function resolveChunkModeForProvider(
  cfgSection: ProviderChunkConfig | undefined,
  accountId?: string | null,
): ChunkMode | undefined {
  if (!cfgSection) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts = cfgSection.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = resolveAccountEntry(accounts, normalizedAccountId);
    const directMode = resolveChannelStreamingChunkMode(direct);
    if (directMode) {
      return directMode;
    }
  }
  return resolveChannelStreamingChunkMode(cfgSection) ?? cfgSection.chunkMode;
}

export function resolveChunkMode(
  cfg: OpenClawConfig | undefined,
  provider?: TextChunkProvider,
  accountId?: string | null,
): ChunkMode {
  if (!provider || provider === INTERNAL_MESSAGE_CHANNEL) {
    return DEFAULT_CHUNK_MODE;
  }
  const channelsConfig = cfg?.channels as Record<string, unknown> | undefined;
  const providerConfig = (channelsConfig?.[provider] ??
    (cfg as Record<string, unknown> | undefined)?.[provider]) as ProviderChunkConfig | undefined;
  const mode = resolveChunkModeForProvider(providerConfig, accountId);
  return mode ?? DEFAULT_CHUNK_MODE;
}

/**
 * Split text on newlines, trimming line whitespace.
 * Blank lines are folded into the next non-empty line as leading "\n" prefixes.
 * Long lines can be split by length (default) or kept intact via splitLongLines:false.
 */
export function chunkByNewline(
  text: string,
  maxLineLength: number,
  opts?: {
    splitLongLines?: boolean;
    trimLines?: boolean;
    isSafeBreak?: (index: number) => boolean;
  },
): string[] {
  if (!text) {
    return [];
  }
  if (maxLineLength <= 0) {
    return text.trim() ? [text] : [];
  }
  const splitLongLines = opts?.splitLongLines !== false;
  const trimLines = opts?.trimLines !== false;
  const lines = splitByNewline(text, opts?.isSafeBreak);
  const chunks: string[] = [];
  let pendingBlankLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      pendingBlankLines += 1;
      continue;
    }

    const maxPrefix = Math.max(0, maxLineLength - 1);
    const cappedBlankLines = pendingBlankLines > 0 ? Math.min(pendingBlankLines, maxPrefix) : 0;
    const prefix = cappedBlankLines > 0 ? "\n".repeat(cappedBlankLines) : "";
    pendingBlankLines = 0;

    const lineValue = trimLines ? trimmed : line;
    if (!splitLongLines || lineValue.length + prefix.length <= maxLineLength) {
      chunks.push(prefix + lineValue);
      continue;
    }

    const firstLimit = Math.max(1, maxLineLength - prefix.length);
    const first = lineValue.slice(0, firstLimit);
    chunks.push(prefix + first);
    const remaining = lineValue.slice(firstLimit);
    if (remaining) {
      chunks.push(...chunkText(remaining, maxLineLength));
    }
  }

  if (pendingBlankLines > 0 && chunks.length > 0) {
    chunks[chunks.length - 1] += "\n".repeat(pendingBlankLines);
  }

  return chunks;
}

/**
 * Split text into chunks on paragraph boundaries (blank lines), preserving lists and
 * single-newline line wraps inside paragraphs.
 *
 * - Only breaks at paragraph separators ("\n\n" or more, allowing whitespace on blank lines)
 * - Packs multiple paragraphs into a single chunk up to `limit`
 * - Falls back to length-based splitting when a single paragraph exceeds `limit`
 *   (unless `splitLongParagraphs` is disabled)
 */
export function chunkByParagraph(
  text: string,
  limit: number,
  opts?: { splitLongParagraphs?: boolean },
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  const splitLongParagraphs = opts?.splitLongParagraphs !== false;

  // Normalize to \n so blank line detection is consistent.
  const normalized = text.replace(/\r\n?/g, "\n");

  // Fast-path: if there are no blank-line paragraph separators, do not split.
  // (We *do not* early-return based on `limit` — newline mode is about paragraph
  // boundaries, not only exceeding a length limit.)
  const paragraphRe = /\n[\t ]*\n+/;
  if (!paragraphRe.test(normalized)) {
    if (normalized.length <= limit) {
      return [normalized];
    }
    if (!splitLongParagraphs) {
      return [normalized];
    }
    return chunkText(normalized, limit);
  }

  const spans = parseFenceSpans(normalized);

  const parts: string[] = [];
  const re = /\n[\t ]*\n+/g; // paragraph break: blank line(s), allowing whitespace
  let lastIndex = 0;
  for (const match of normalized.matchAll(re)) {
    const idx = match.index ?? 0;

    // Do not split on blank lines that occur inside fenced code blocks.
    if (!isSafeFenceBreak(spans, idx)) {
      continue;
    }

    parts.push(normalized.slice(lastIndex, idx));
    lastIndex = idx + match[0].length;
  }
  parts.push(normalized.slice(lastIndex));

  const chunks: string[] = [];
  for (const part of parts) {
    const paragraph = part.replace(/\s+$/g, "");
    if (!paragraph.trim()) {
      continue;
    }
    if (paragraph.length <= limit) {
      chunks.push(paragraph);
    } else if (!splitLongParagraphs) {
      chunks.push(paragraph);
    } else {
      chunks.push(...chunkText(paragraph, limit));
    }
  }

  return chunks;
}

/**
 * Unified chunking function that dispatches based on mode.
 */
export function chunkTextWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  if (mode === "newline") {
    return chunkByParagraph(text, limit);
  }
  return chunkText(text, limit);
}

export function chunkMarkdownTextWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  if (mode === "newline") {
    // Paragraph chunking is fence-safe because we never split at arbitrary indices.
    // If a paragraph must be split by length, defer to the markdown-aware chunker.
    const paragraphChunks = chunkByParagraph(text, limit, { splitLongParagraphs: false });
    const out: string[] = [];
    for (const chunk of paragraphChunks) {
      const nested = chunkMarkdownText(chunk, limit);
      if (!nested.length && chunk) {
        out.push(chunk);
      } else {
        out.push(...nested);
      }
    }
    return out;
  }
  return chunkMarkdownText(text, limit);
}

function splitByNewline(
  text: string,
  isSafeBreak: (index: number) => boolean = () => true,
): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" && isSafeBreak(i)) {
      lines.push(text.slice(start, i));
      start = i + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

function resolveChunkEarlyReturn(text: string, limit: number): string[] | undefined {
  if (!text) {
    return [];
  }
  if (limit <= 0) {
    return [text];
  }
  if (text.length <= limit) {
    return [text];
  }
  return undefined;
}

export function chunkText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }
  return chunkTextByBreakResolver(text, limit, (window) => {
    // 1) Prefer a newline break inside the window (outside parentheses).
    const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(window, 0, window.length);
    // 2) Otherwise prefer the last whitespace (word boundary) inside the window.
    return lastNewline > 0 ? lastNewline : lastWhitespace;
  });
}

export function chunkMarkdownText(text: string, limit: number): string[] {
  const early = resolveChunkEarlyReturn(text, limit);
  if (early) {
    return early;
  }

  const chunks: string[] = [];
  const spans = parseFenceSpans(text);
  const tableSpans = parseTableSpans(text, spans);
  const blockquoteSpans = parseBlockquoteSpans(text);
  let start = 0;
  let reopenFence: ReturnType<typeof findFenceSpanAt> | undefined;
  let reopenBlockquote: ReturnType<typeof findBlockquoteAt> | undefined;
  let reopenInline: string | undefined;
  let reopenTableHeader: string | undefined;

  while (start < text.length) {
    const reopenPrefix = reopenFence
      ? `${reopenFence.openLine}\n`
      : reopenTableHeader
        ? reopenTableHeader
        : "";
    const inlineReopenPrefix = reopenInline ?? "";
    const fullReopenPrefix = `${reopenPrefix}${inlineReopenPrefix}`;
    const contentLimit = Math.max(1, limit - fullReopenPrefix.length);
    if (text.length - start <= contentLimit) {
      let finalContent = text.slice(start);
      if (reopenBlockquote) {
        const bqEnd = Math.min(reopenBlockquote.end - start, finalContent.length);
        finalContent =
          reapplyBlockquotePrefix(finalContent.slice(0, bqEnd), reopenBlockquote.prefix) +
          finalContent.slice(bqEnd);
      }
      const finalChunk = `${fullReopenPrefix}${finalContent}`;
      if (finalChunk.length > 0) {
        chunks.push(finalChunk);
      }
      break;
    }

    const windowEnd = Math.min(text.length, start + contentLimit);
    const softBreak = pickSafeBreakIndex(text, start, windowEnd, spans, tableSpans);
    let breakIdx = softBreak > start ? softBreak : windowEnd;

    const initialFence = isSafeFenceBreak(spans, breakIdx)
      ? undefined
      : findFenceSpanAt(spans, breakIdx);

    let fenceToSplit = initialFence;
    if (initialFence) {
      const closeLine = `${initialFence.indent}${initialFence.marker}`;
      const maxIdxIfNeedNewline = start + (contentLimit - (closeLine.length + 1));

      if (maxIdxIfNeedNewline <= start) {
        fenceToSplit = undefined;
        breakIdx = windowEnd;
      } else {
        const minProgressIdx = Math.min(
          text.length,
          Math.max(start + 1, initialFence.start + initialFence.openLine.length + 2),
        );
        const maxIdxIfAlreadyNewline = start + (contentLimit - closeLine.length);

        let pickedNewline = false;
        let lastNewline = text.lastIndexOf("\n", Math.max(start, maxIdxIfAlreadyNewline - 1));
        while (lastNewline >= start) {
          const candidateBreak = lastNewline + 1;
          if (candidateBreak < minProgressIdx) {
            break;
          }
          const candidateFence = findFenceSpanAt(spans, candidateBreak);
          if (candidateFence && candidateFence.start === initialFence.start) {
            breakIdx = candidateBreak;
            pickedNewline = true;
            break;
          }
          lastNewline = text.lastIndexOf("\n", lastNewline - 1);
        }

        if (!pickedNewline) {
          if (minProgressIdx > maxIdxIfAlreadyNewline) {
            fenceToSplit = undefined;
            breakIdx = windowEnd;
          } else {
            breakIdx = Math.max(minProgressIdx, maxIdxIfNeedNewline);
          }
        }
      }

      const fenceAtBreak = findFenceSpanAt(spans, breakIdx);
      fenceToSplit =
        fenceAtBreak && fenceAtBreak.start === initialFence.start ? fenceAtBreak : undefined;
    }

    // Check if we're breaking inside a table
    const tableAtBreak = findTableSpanAt(tableSpans, breakIdx);
    if (tableAtBreak) {
      // Try to break before the table so it stays atomic.
      // If the table starts too close to `start`, fall through and let
      // the continuation-header logic (below) handle the split.
      const beforeTable = text.lastIndexOf("\n", tableAtBreak.start);
      if (beforeTable > start) {
        breakIdx = beforeTable;
      }
      // If table fits as atomic unit, push breakIdx past it
      // Otherwise the header will be repeated in continuation (handled below)
    }

    const rawContent = text.slice(start, breakIdx);
    if (!rawContent) {
      break;
    }

    let contentForChunk = rawContent;
    if (reopenBlockquote) {
      // Only apply the prefix up to the end of the blockquote span.
      // Lines after the span end are plain prose and must not be quoted.
      const bqEnd = Math.min(reopenBlockquote.end - start, rawContent.length);
      const insideQuote = rawContent.slice(0, bqEnd);
      const afterQuote = rawContent.slice(bqEnd);
      contentForChunk = reapplyBlockquotePrefix(insideQuote, reopenBlockquote.prefix) + afterQuote;
    }

    // Detect unmatched inline markers in this chunk (only when not inside a fence)
    let inlineClose = "";
    let inlineReopenNext = "";
    if (!fenceToSplit) {
      const chunkForInlineScan = `${fullReopenPrefix}${contentForChunk}`;
      const inlineSpans = parseFenceSpans(chunkForInlineScan);
      const inlineState = scanUnmatchedInlineMarkers(chunkForInlineScan, inlineSpans);
      inlineClose = buildInlineClose(inlineState);
      inlineReopenNext = buildInlineReopen(inlineState);
    }

    let rawChunk = `${fullReopenPrefix}${contentForChunk}`;
    const brokeOnSeparator = breakIdx < text.length && /\s/.test(text[breakIdx]);
    let nextStart = Math.min(text.length, breakIdx + (brokeOnSeparator ? 1 : 0));

    // Detect blockquote context at break point
    const bqAtBreak = findBlockquoteAt(blockquoteSpans, breakIdx);

    if (fenceToSplit) {
      const closeLine = `${fenceToSplit.indent}${fenceToSplit.marker}`;
      rawChunk = rawChunk.endsWith("\n") ? `${rawChunk}${closeLine}` : `${rawChunk}\n${closeLine}`;
      reopenFence = fenceToSplit;
      reopenBlockquote = undefined;
    } else {
      nextStart = skipLeadingNewlines(text, nextStart);
      reopenFence = undefined;
      reopenBlockquote = bqAtBreak;
    }

    // Append inline close markers if needed (only outside fences)
    if (!fenceToSplit && inlineClose) {
      rawChunk += inlineClose;
      reopenInline = inlineReopenNext;
    } else {
      reopenInline = undefined;
    }

    // Handle table header repetition for continuation
    const tableForContinuation = findTableSpanAt(tableSpans, nextStart);
    if (tableForContinuation && nextStart > tableForContinuation.start) {
      reopenTableHeader = `${tableForContinuation.headerLine}\n${tableForContinuation.separatorLine}\n`;
    } else {
      reopenTableHeader = undefined;
    }

    chunks.push(rawChunk);
    start = nextStart;
  }
  return chunks;
}

function skipLeadingNewlines(value: string, start = 0): number {
  let i = start;
  while (i < value.length && value[i] === "\n") {
    i++;
  }
  return i;
}

function pickSafeBreakIndex(
  text: string,
  start: number,
  end: number,
  spans: ReturnType<typeof parseFenceSpans>,
  tableSpans?: ReturnType<typeof parseTableSpans>,
): number {
  const { lastNewline, lastWhitespace } = scanParenAwareBreakpoints(
    text,
    start,
    end,
    (index) =>
      isSafeFenceBreak(spans, index) && (!tableSpans || isSafeTableBreak(tableSpans, index)),
  );

  if (lastNewline > start) {
    return lastNewline;
  }
  if (lastWhitespace > start) {
    return lastWhitespace;
  }
  return -1;
}

function scanParenAwareBreakpoints(
  text: string,
  start: number,
  end: number,
  isAllowed: (index: number) => boolean = () => true,
): { lastNewline: number; lastWhitespace: number } {
  let lastNewline = -1;
  let lastWhitespace = -1;
  let depth = 0;

  for (let i = start; i < end; i++) {
    if (!isAllowed(i)) {
      continue;
    }
    const char = text[i];
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth !== 0) {
      continue;
    }
    if (char === "\n") {
      lastNewline = i;
    } else if (/\s/.test(char)) {
      lastWhitespace = i;
    }
  }

  return { lastNewline, lastWhitespace };
}
