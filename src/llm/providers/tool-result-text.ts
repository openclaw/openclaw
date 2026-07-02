import { redactSecrets, redactToolPayloadText } from "../../logging/redact.js";
import { truncateUtf16Safe } from "../../shared/utf16-slice.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";

const PROVIDER_TOOL_RESULT_MAX_CHARS = 8000;
const IMAGE_TOOL_RESULT_TYPES = new Set(["image", "image_url", "input_image"]);
const AUDIO_TOOL_RESULT_TYPES = new Set(["audio", "input_audio", "output_audio"]);
const MEDIA_ONLY_TOOL_RESULT_TYPES = new Set([
  ...IMAGE_TOOL_RESULT_TYPES,
  ...AUDIO_TOOL_RESULT_TYPES,
]);
const INLINE_DATA_URI_PATTERN =
  /(^|[^A-Za-z0-9_])data:([a-z][a-z0-9.+-]*\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^,;"'\s]+|;base64)*,[^\s"'<>)]+)/gi;
const MIME_KEY_CANDIDATES = [
  "mimeType",
  "mime_type",
  "mediaType",
  "media_type",
  "contentType",
  "content_type",
];
const TEXTUAL_MIME_PATTERN =
  /^(?:text\/|application\/(?:json|ld\+json|x-ndjson|xml|javascript|x-www-form-urlencoded)|[^/]+\/[^+]+\+(?:json|xml)$)/i;
const OPAQUE_OR_BINARY_FIELD_RE = /^(?:blob|buffer|bytes|encrypted_content|encrypted_stdout)$/i;
const TEXT_FIELD_CANDIDATES = ["text", "output", "content"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolResultBlocks(blocks: unknown): readonly unknown[] {
  if (Array.isArray(blocks)) {
    return blocks;
  }
  if (blocks === null || blocks === undefined) {
    return [];
  }
  return [blocks];
}

function primitiveToolResultText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readMimeType(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of MIME_KEY_CANDIDATES) {
    const mimeType = value[key];
    if (typeof mimeType === "string" && mimeType.trim().length > 0) {
      return mimeType;
    }
  }
  return undefined;
}

function isBinaryMimeType(mimeType: string): boolean {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return normalized ? !TEXTUAL_MIME_PATTERN.test(normalized) : false;
}

function describeOmittedValue(value: unknown, label: string): string {
  const length = typeof value === "string" ? value.length : JSON.stringify(value)?.length;
  return length ? `[${label} omitted: ${length} chars]` : `[${label} omitted]`;
}

function redactInlineDataUris(value: string): string {
  return value.replace(
    INLINE_DATA_URI_PATTERN,
    (_match, prefix: string, uri: string) => `${prefix}[inline data URI: ${uri.length} chars]`,
  );
}

function redactStructuredTextValue(value: string): string {
  const redacted = redactToolPayloadText(value);
  const trimmed = redacted.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return redacted;
  }
  try {
    const redactedWrapper = redactSecrets({ structuredTextValue: JSON.parse(redacted) });
    return JSON.stringify(redactedWrapper.structuredTextValue);
  } catch {
    return redacted;
  }
}

function stringifyStructuredBlock(block: Record<string, unknown>): string | undefined {
  const seen = new WeakSet<object>();
  try {
    const redactedWrapper = redactSecrets({ structuredToolResult: block });
    const redactedBlock = redactedWrapper.structuredToolResult;
    const serialized = JSON.stringify(
      redactedBlock,
      function structuredToolResultReplacer(this: unknown, key, value) {
        if (OPAQUE_OR_BINARY_FIELD_RE.test(key)) {
          return `[omitted ${key}]`;
        }
        if (key === "data") {
          const mimeType = readMimeType(this);
          if (mimeType && isBinaryMimeType(mimeType)) {
            return describeOmittedValue(value, "binary data");
          }
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        if (typeof value === "string") {
          return redactInlineDataUris(redactStructuredTextValue(value));
        }
        if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
          return undefined;
        }
        if (!value || typeof value !== "object") {
          return value;
        }
        if (seen.has(value)) {
          return "[Circular]";
        }
        seen.add(value);
        return value;
      },
    );
    if (!serialized || serialized === "{}") {
      return undefined;
    }
    return serialized;
  } catch {
    return undefined;
  }
}

function truncateProviderToolText(text: string): string {
  if (text.length <= PROVIDER_TOOL_RESULT_MAX_CHARS) {
    return text;
  }
  return `${truncateUtf16Safe(text, PROVIDER_TOOL_RESULT_MAX_CHARS)}\n…(truncated)…`;
}

export function describeToolResultMediaPlaceholder(blocks: unknown): string | undefined {
  let hasImage = false;
  let hasAudio = false;

  for (const block of normalizeToolResultBlocks(blocks)) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const mimeType = readMimeType(record);

    if (
      (type && IMAGE_TOOL_RESULT_TYPES.has(type)) ||
      mimeType?.toLowerCase().startsWith("image/")
    ) {
      hasImage = true;
    }
    if (
      (type && AUDIO_TOOL_RESULT_TYPES.has(type)) ||
      mimeType?.toLowerCase().startsWith("audio/")
    ) {
      hasAudio = true;
    }
  }

  if (hasImage && hasAudio) {
    return "(see attached media)";
  }
  if (hasAudio) {
    return "(see attached audio)";
  }
  if (hasImage) {
    return "(see attached image)";
  }
  return undefined;
}

export function extractToolResultBlockText(block: unknown): string | undefined {
  const primitiveText = primitiveToolResultText(block);
  if (primitiveText !== undefined) {
    return primitiveText ? sanitizeSurrogates(primitiveText) : undefined;
  }
  if (!block || typeof block !== "object") {
    return undefined;
  }
  const record = block as Record<string, unknown>;
  if (typeof record.type === "string" && MEDIA_ONLY_TOOL_RESULT_TYPES.has(record.type)) {
    return undefined;
  }
  if (record.type === "text") {
    const text = primitiveToolResultText(record.text) ?? "";
    return text ? sanitizeSurrogates(text) : undefined;
  }
  if (typeof record.type !== "string") {
    for (const key of TEXT_FIELD_CANDIDATES) {
      const text = primitiveToolResultText(record[key]);
      if (text) {
        return sanitizeSurrogates(text);
      }
    }
  }
  const structured = stringifyStructuredBlock(record);
  return structured ? sanitizeSurrogates(truncateProviderToolText(structured)) : undefined;
}

export function extractToolResultText(blocks: unknown): string {
  const explicitTexts: string[] = [];
  const structuredTexts: string[] = [];
  for (const block of normalizeToolResultBlocks(blocks)) {
    const text = extractToolResultBlockText(block);
    if (!text) {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type === "text") {
      explicitTexts.push(text);
    } else {
      structuredTexts.push(text);
    }
  }
  if (explicitTexts.length > 0) {
    return sanitizeSurrogates(explicitTexts.join("\n"));
  }
  return sanitizeSurrogates(truncateProviderToolText(structuredTexts.join("\n")));
}
