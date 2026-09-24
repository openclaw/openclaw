// Text normalisation for inbound prompt metadata: null-byte stripping, head+tail
// truncation, and the transcript-field/body sanitizers. Extracted from
// inbound-meta.ts so that file and its carrier siblings stay under the line cap
// and so the carrier module can reuse these without importing back into it.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe, truncateUtf16Safe } from "../../utils.js";
import {
  MAX_CONTEXT_JSON_STRING_CHARS,
  neutralizeMarkdownFences,
} from "./channel-prompt-context.js";

export const MAX_UNTRUSTED_TRANSCRIPT_FIELD_CHARS = 500;

const HEAD_TAIL_OMISSION_MARKER = "…[omitted]…";

const HEAD_TAIL_MARKER_LENGTH = HEAD_TAIL_OMISSION_MARKER.length;

const MIN_HEAD_TAIL_CHARS = 20;

function stripNullBytes(value: string): string {
  return value.replaceAll("\u0000", "");
}

export function normalizePromptMetadataString(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const sanitized = stripNullBytes(normalized);
  return sanitized || undefined;
}

export function normalizePromptMetadataStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((entry) => normalizePromptMetadataString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

export function sanitizePromptBody(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = stripNullBytes(value);
  return sanitized || undefined;
}

/**
 * Applies head+tail truncation so the result is ≤ maxChars and the downstream
 * {@link truncateContextJsonString} (prefix-only 2000-char cap) is a no-op.
 * Head and tail portions are sized to keep the body within
 * {@link MAX_CONTEXT_JSON_STRING_CHARS}, preserving actionable tail content
 * that prefix-only truncation would drop.
 */
export function truncateBodyHeadTail(
  body: string,
  maxChars = MAX_CONTEXT_JSON_STRING_CHARS,
): string {
  if (body.length <= maxChars) {
    return body;
  }
  const available = maxChars - HEAD_TAIL_MARKER_LENGTH;
  if (available < MIN_HEAD_TAIL_CHARS * 2) {
    return `${truncateUtf16Safe(body, Math.max(0, maxChars - 14)).trimEnd()}…[truncated]`;
  }
  // Budget in UTF-16 code units because truncateContextJsonString enforces
  // that same cap after JSON serialization.
  const headChars = Math.floor(available * 0.6);
  const tailChars = available - headChars;
  const head = truncateUtf16Safe(body, headChars);
  const tail = sliceUtf16Safe(body, -tailChars);
  return `${head}${HEAD_TAIL_OMISSION_MARKER}${tail}`;
}

function truncateUntrustedTranscriptField(value: string): string {
  if (value.length <= MAX_UNTRUSTED_TRANSCRIPT_FIELD_CHARS) {
    return value;
  }
  return `${truncateUtf16Safe(
    value,
    Math.max(0, MAX_UNTRUSTED_TRANSCRIPT_FIELD_CHARS - 14),
  ).trimEnd()}…[truncated]`;
}

export function sanitizeTranscriptField(value: unknown): string | undefined {
  const body = sanitizePromptBody(value);
  if (!body) {
    return undefined;
  }
  return neutralizeMarkdownFences(truncateUntrustedTranscriptField(body))
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeTranscriptBody(value: unknown): string | undefined {
  const body = sanitizePromptBody(value);
  if (!body) {
    return undefined;
  }
  const sanitized = neutralizeMarkdownFences(truncateBodyHeadTail(body))
    .replace(/\s+/g, " ")
    .trim();
  return sanitized || undefined;
}
