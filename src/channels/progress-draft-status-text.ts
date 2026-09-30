import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatReasoningMessage } from "../agents/embedded-agent-utils.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { compactProgressText } from "../shared/text-truncate.js";
import { type CodeRegion, findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { stripInlineDirectiveTagsForDelivery } from "../utils/directive-tags.js";

const REASONING_PROGRESS_TAG_RE =
  /<\s*(\/?)\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>/giu;
const REASONING_PROGRESS_HEADING_RE =
  /^\s*(?:>\s*)?(?:Reasoning:\s*(?:\r?\n|\r)\s*|Thinking\.{0,3}\s*(?:\r?\n|\r)\s*(?:\r?\n|\r)\s*)/i;
const REASONING_PROGRESS_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "mm:think",
  "mm:thinking",
  "mm:thought",
] as const;
const REASONING_PROGRESS_TAG_PREFIXES = REASONING_PROGRESS_TAG_NAMES.flatMap((name) => [
  `<${name}`,
  `</${name}`,
]);

function normalizeReasoningProgressLine(text: string): string {
  const reasoningText = readReasoningProgressTextOutsideCode(text);
  if (reasoningText === undefined) {
    return "";
  }
  return stripReasoningProgressTagsOutsideCode(reasoningText)
    .replace(REASONING_PROGRESS_HEADING_RE, "")
    .replace(/\s{2,}|[^\S ]/g, " ")
    .trim();
}

function readReasoningProgressTextOutsideCode(text: string): string | undefined {
  if (isPartialReasoningProgressTagPrefix(text)) {
    // Hold partial tags until more bytes arrive; otherwise a streaming "<thi"
    // fragment can flash as user-visible progress.
    return undefined;
  }
  let codeRegions: CodeRegion[] | undefined;
  let hasTags = false;
  let inReasoning = false;
  let cursor = 0;
  const chunks: string[] = [];
  for (const match of text.matchAll(REASONING_PROGRESS_TAG_RE)) {
    const offset = match.index ?? 0;
    if (isInsideCode(offset, (codeRegions ??= findCodeRegions(text)))) {
      // Preserve code examples that mention reasoning tags; only actual model
      // wrapper tags outside code delimit private reasoning progress.
      continue;
    }
    hasTags = true;
    if (match[1]) {
      if (inReasoning) {
        chunks.push(text.slice(cursor, offset));
      }
      inReasoning = false;
      cursor = offset + match[0].length;
      continue;
    }
    if (inReasoning) {
      chunks.push(text.slice(cursor, offset));
    }
    inReasoning = true;
    cursor = offset + match[0].length;
  }
  if (!hasTags) {
    return text;
  }
  if (inReasoning) {
    chunks.push(text.slice(cursor));
  }
  return chunks.join("").trim();
}

function isPartialReasoningProgressTagPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("<") || trimmed.includes(">")) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  return REASONING_PROGRESS_TAG_PREFIXES.some(
    (prefix) => prefix.startsWith(normalized) || normalized.startsWith(prefix),
  );
}

function stripReasoningProgressTagsOutsideCode(text: string): string {
  let codeRegions: CodeRegion[] | undefined;
  return text.replace(REASONING_PROGRESS_TAG_RE, (match, _closing: string, offset: number) =>
    isInsideCode(offset, (codeRegions ??= findCodeRegions(text))) ? match : "",
  );
}

function normalizeReasoningProgressInput(text: string): string {
  const normalized = normalizeReasoningProgressLine(text);
  const italic = normalized.match(/^_(.*)_$/u);
  return (italic?.[1] ?? normalized).trim();
}

export function formatReasoningProgressDisplayLine(text: string, maxChars: number): string {
  const normalizedText = normalizeReasoningProgressInput(text);
  const formatted = normalizeReasoningProgressLine(formatReasoningMessage(normalizedText));
  if (!formatted) {
    return "";
  }
  if (
    Array.from(sliceUtf16Safe(formatted, 0, (Math.max(0, maxChars) + 1) * 2)).length <= maxChars
  ) {
    return formatted;
  }
  const italic = formatted.match(/^_(.*)_$/u);
  if (!italic) {
    return compactProgressText(formatted, maxChars);
  }
  const body = compactProgressText((italic[1] ?? "").trim(), Math.max(1, maxChars - 2));
  return body ? `_${body}_` : "";
}

export function sanitizeProgressStatusText(text: string): string {
  const cleaned = stripInlineDirectiveTagsForDelivery(text).text.trim();
  if (!cleaned || isSilentCommentaryProgressText(cleaned)) {
    return "";
  }
  return redactToolPayloadText(cleaned);
}

export function normalizeCommentaryProgressText(text: string): string {
  const cleaned = sanitizeProgressStatusText(text);
  if (!cleaned) {
    return "";
  }
  return cleaned
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((line) => `_${line}_`)
    .join("\n");
}

function isSilentCommentaryProgressText(text: string): boolean {
  const normalized = text.replace(/^[\s*_`~]+|[\s*_`~]+$/gu, "").trim();
  return /^NO_REPLY$/iu.test(normalized);
}

function mergeReasoningProgressText(
  current: string,
  incoming: string,
  options?: { snapshot?: boolean },
  // Normalized form of `current` when the caller already computed it for the
  // previous delta. Reasoning arrives as many small deltas that append to an
  // ever-growing buffer, and normalization is a full-buffer scan (markdown
  // parse + tag strip), so recomputing it here every delta is quadratic in the
  // reasoning length. The hint must equal normalizeReasoningProgressInput(current).
  normalizedCurrentHint?: string,
): string {
  if (!current) {
    return incoming;
  }
  const normalizedCurrent = normalizedCurrentHint ?? normalizeReasoningProgressInput(current);
  const normalizedIncoming = normalizeReasoningProgressInput(incoming);
  if (!normalizedIncoming) {
    return shouldAppendEmptyReasoningProgressDelta(current, incoming)
      ? `${current}${incoming}`
      : current;
  }
  if (normalizedIncoming === normalizedCurrent) {
    return current;
  }
  if (
    options?.snapshot === true ||
    REASONING_PROGRESS_HEADING_RE.test(incoming) ||
    (normalizedCurrent && normalizedIncoming.startsWith(normalizedCurrent))
  ) {
    // Snapshot-style providers resend the full reasoning text. Replace the
    // buffer instead of duplicating the already-seen prefix.
    return incoming;
  }
  return `${current}${incoming}`;
}

function shouldAppendEmptyReasoningProgressDelta(current: string, incoming: string): boolean {
  return (
    isPartialReasoningProgressTagPrefix(current) ||
    isPartialReasoningProgressTagPrefix(incoming) ||
    hasReasoningProgressTagOutsideCode(incoming)
  );
}

function hasReasoningProgressTagOutsideCode(text: string): boolean {
  let codeRegions: CodeRegion[] | undefined;
  for (const match of text.matchAll(REASONING_PROGRESS_TAG_RE)) {
    if (!isInsideCode(match.index ?? 0, (codeRegions ??= findCodeRegions(text)))) {
      return true;
    }
  }
  return false;
}
/**
 * Commentary line identity. An explicit item id owns its line. Without one,
 * providers stream cumulative snapshots ("Checking" → "Checking the
 * workspace"), so a snapshot that continues the open line reuses its id and
 * updates in place; anything else starts a new line.
 */
export function resolveCommentaryLineId(commentary: {
  itemId?: string;
  normalized: string;
  bareNormalized: string;
  lastIdLessCommentaryId?: string;
  lastIdLessCommentaryBare: string;
}): string {
  if (commentary.itemId) {
    return `commentary:${commentary.itemId}`;
  }
  if (!commentary.normalized) {
    // Sanitized to nothing (directive-only / NO_REPLY): no line to address, so
    // it cannot retract the open one. Only an explicit itemId clears a line.
    return "";
  }
  const continuesOpenLine =
    Boolean(commentary.lastIdLessCommentaryBare) &&
    (commentary.bareNormalized.startsWith(commentary.lastIdLessCommentaryBare) ||
      commentary.lastIdLessCommentaryBare.startsWith(commentary.bareNormalized));
  if (continuesOpenLine && commentary.lastIdLessCommentaryId) {
    return commentary.lastIdLessCommentaryId;
  }
  return `commentary:${commentary.normalized}`;
}

export function createReasoningProgressAccumulator() {
  let rawText = "";
  // Memoize normalizeReasoningProgressInput(rawText) across deltas. Each merge
  // needs the normalized form of the accumulated buffer twice — once to compare
  // against the incoming delta, once to build the returned line — and each is a
  // full-buffer scan. Reusing the value computed for the buffer we just emitted
  // keeps a long reasoning stream from re-normalizing its whole prefix on every
  // delta. Keyed by exact string identity so it is only reused for the same
  // buffer; derived from the line form below so it costs nothing extra.
  let normalizedInputKey: string | undefined;
  let normalizedInputValue = "";
  return {
    reset() {
      rawText = "";
      normalizedInputKey = undefined;
      normalizedInputValue = "";
    },
    merge(this: void, text?: string, options?: { snapshot?: boolean }): string {
      if (!text) {
        return "";
      }
      const currentHint = rawText === normalizedInputKey ? normalizedInputValue : undefined;
      rawText = mergeReasoningProgressText(rawText, text, options, currentHint);
      const normalizedLine = normalizeReasoningProgressLine(rawText);
      // normalizeReasoningProgressInput(rawText) is exactly the italic-unwrapped,
      // trimmed line form, so cache it for the next delta's merge without a
      // second full-buffer parse.
      const italic = normalizedLine.match(/^_(.*)_$/u);
      normalizedInputKey = rawText;
      normalizedInputValue = (italic?.[1] ?? normalizedLine).trim();
      return redactToolPayloadText(normalizedLine);
    },
  };
}
