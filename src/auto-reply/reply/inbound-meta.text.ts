// Text normalization for inbound prompt metadata: null-byte stripping, head+tail
// truncation, and the transcript sanitizer. Extracted from inbound-meta.ts so the
// Current-message module can reuse these without importing back into it.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  sliceUtf16Safe,
  truncateUtf16Safe,
  truncateWithMarker,
} from "@openclaw/normalization-core/utf16-slice";
import {
  MAX_CONTEXT_JSON_STRING_CHARS,
  neutralizeMarkdownFences,
} from "./channel-prompt-context.js";

export const MAX_UNTRUSTED_TRANSCRIPT_FIELD_CHARS = 500;

export function normalizePromptMetadataString(value: unknown): string | undefined {
  return normalizeOptionalString(value)?.replaceAll("\u0000", "") || undefined;
}

export function normalizePromptMetadataStringArray(
  value: string[] | undefined,
): string[] | undefined {
  const normalized = value
    ?.map(normalizePromptMetadataString)
    .filter((entry): entry is string => Boolean(entry));
  return normalized?.length ? normalized : undefined;
}

export function sanitizePromptBody(value: unknown): string | undefined {
  return typeof value === "string" ? value.replaceAll("\u0000", "") || undefined : undefined;
}

const HEAD_TAIL_OMISSION_MARKER = "…[omitted]…";

// Retain actionable tail content within the downstream JSON string cap.
export function truncateBodyHeadTail(body: string): string {
  if (body.length <= MAX_CONTEXT_JSON_STRING_CHARS) {
    return body;
  }
  const available = MAX_CONTEXT_JSON_STRING_CHARS - HEAD_TAIL_OMISSION_MARKER.length;
  const headChars = Math.floor(available * 0.6);
  const tailChars = available - headChars;
  const head = truncateUtf16Safe(body, headChars);
  const tail = sliceUtf16Safe(body, -tailChars);
  return `${head}${HEAD_TAIL_OMISSION_MARKER}${tail}`;
}

export function sanitizeTranscriptText(
  value: unknown,
  kind: "field" | "body" = "field",
): string | undefined {
  const body = sanitizePromptBody(value);
  if (!body) {
    return undefined;
  }
  const truncated =
    kind === "body"
      ? truncateBodyHeadTail(body)
      : truncateWithMarker(body, MAX_UNTRUSTED_TRANSCRIPT_FIELD_CHARS, {
          marker: "…[truncated]",
          reserve: 14,
          trimEnd: true,
        });
  const sanitized = neutralizeMarkdownFences(truncated).replace(/\s+/g, " ").trim();
  return kind === "body" ? sanitized || undefined : sanitized;
}
