import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";

const isMediaMimeType = (value: unknown): value is string =>
  typeof value === "string" && /^(?:image|video)\//iu.test(value.trim());

const normalizeMediaMimeType = (value: unknown): string | undefined =>
  isMediaMimeType(value) ? value.trim().toLowerCase() : undefined;

const ASF_VIDEO_SIGNATURE = Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex");

function mediaMimeTypeForRecord(value: Record<string, unknown>): string | undefined {
  return (
    normalizeMediaMimeType(value.mimeType) ??
    normalizeMediaMimeType(value.mediaType) ??
    normalizeMediaMimeType(value.media_type)
  );
}

function mediaMimeTypeFieldsForRecord(value: Record<string, unknown>): string[] {
  return ["mimeType", "mediaType", "media_type"].filter((key) => isMediaMimeType(value[key]));
}

function hasVideoContainerSignature(base64: string): boolean {
  // Redaction exemptions require actual media bytes: otherwise a credential in
  // a fake video block could bypass transcript persistence redaction.
  const prefix = Buffer.from(base64.slice(0, 32), "base64");
  return (
    (prefix.length >= 12 && prefix.subarray(4, 8).toString("ascii") === "ftyp") ||
    (prefix.length >= 4 && prefix.readUInt32BE(0) === 0x1a45dfa3) ||
    (prefix.length >= ASF_VIDEO_SIGNATURE.length &&
      prefix.subarray(0, ASF_VIDEO_SIGNATURE.length).equals(ASF_VIDEO_SIGNATURE)) ||
    (prefix.length >= 4 && prefix.subarray(0, 4).toString("ascii") === "OggS") ||
    (prefix.length >= 12 &&
      prefix.subarray(0, 4).toString("ascii") === "RIFF" &&
      prefix.subarray(8, 12).toString("ascii") === "AVI ") ||
    (prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "FLV") ||
    (prefix.length >= 4 &&
      prefix[0] === 0 &&
      prefix[1] === 0 &&
      prefix[2] === 1 &&
      (prefix[3] === 0xba || prefix[3] === 0xb3))
  );
}

function sanitizeOpaqueMediaBase64(
  base64: string,
  mimeType: string | undefined,
): { mimeType: string; base64: string } | undefined {
  if (!mimeType) {
    return undefined;
  }
  if (mimeType.startsWith("image/")) {
    return sanitizeInlineImageBase64({ mimeType, base64 });
  }
  const canonicalPayload = canonicalizeBase64(base64);
  return canonicalPayload && hasVideoContainerSignature(canonicalPayload)
    ? { mimeType, base64: canonicalPayload }
    : undefined;
}

function isOpaqueMediaDataBlock(value: Record<string, unknown>): boolean {
  return (
    (value.type === "image" || value.type === "video" || value.type === "base64") &&
    typeof value.data === "string" &&
    sanitizeOpaqueMediaBase64(value.data, mediaMimeTypeForRecord(value)) !== undefined
  );
}

export function sanitizeTranscriptMediaRecord(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const isMediaBlock = source.type === "image" || source.type === "video";
  const isBase64SourceBlock = source.type === "base64";
  if ((!isMediaBlock && !isBase64SourceBlock) || typeof source.data !== "string") {
    return undefined;
  }
  const mimeTypeFields = mediaMimeTypeFieldsForRecord(source);
  if (mimeTypeFields.length === 0) {
    return undefined;
  }
  const sanitized = sanitizeOpaqueMediaBase64(source.data, mediaMimeTypeForRecord(source));
  if (!sanitized) {
    return undefined;
  }
  const hasCanonicalMimeTypes = mimeTypeFields.every((key) => source[key] === sanitized.mimeType);
  if (source.data === sanitized.base64 && hasCanonicalMimeTypes) {
    return source;
  }
  const next: Record<string, unknown> = { ...source, data: sanitized.base64 };
  for (const field of mimeTypeFields) {
    next[field] = sanitized.mimeType;
  }
  return next;
}

function startsWithDataUrl(value: string): boolean {
  return value.slice(0, "data:".length).toLowerCase() === "data:";
}

function sanitizeInlineMediaDataUrl(value: string): string | undefined {
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  const [mimeType, ...options] = value.slice("data:".length, commaIndex).split(";");
  const normalizedMimeType = normalizeMediaMimeType(mimeType);
  if (!normalizedMimeType || !options.some((option) => option.trim().toLowerCase() === "base64")) {
    return undefined;
  }
  if (normalizedMimeType.startsWith("image/")) {
    return sanitizeInlineImageDataUrlForStorage(value);
  }
  const sanitized = sanitizeOpaqueMediaBase64(value.slice(commaIndex + 1), normalizedMimeType);
  return sanitized ? `data:${sanitized.mimeType};base64,${sanitized.base64}` : undefined;
}

function sanitizeMediaDataUrlField(
  source: Record<string, unknown>,
  key: string,
  value: string,
): string | undefined {
  if (!startsWithDataUrl(value)) {
    return undefined;
  }
  const isMediaDataUrlField =
    (source.type === "input_image" && key === "image_url") ||
    ((source.type === "image" || source.type === "image_url") && key === "url") ||
    (source.type === "image" && (key === "source" || key === "data")) ||
    (source.type === "input_video" && key === "video_url") ||
    ((source.type === "video" || source.type === "video_url") && key === "url") ||
    (source.type === "video" && (key === "source" || key === "data"));
  return isMediaDataUrlField ? sanitizeInlineMediaDataUrl(value) : undefined;
}

export function sanitizeTranscriptMediaDataUrlField(params: {
  source: Record<string, unknown>;
  key: string;
  value: string;
  preserveMediaDataUrlFields: boolean;
}): string | undefined {
  if (params.preserveMediaDataUrlFields && params.key === "url") {
    return startsWithDataUrl(params.value) ? sanitizeInlineMediaDataUrl(params.value) : undefined;
  }
  return sanitizeMediaDataUrlField(params.source, params.key, params.value);
}

export function shouldPreserveTranscriptMediaPayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  preserveMediaDataUrlFields: boolean,
): boolean {
  if (typeof item !== "string") {
    return false;
  }
  if (key === "data" && isOpaqueMediaDataBlock(source)) {
    return true;
  }
  if (preserveMediaDataUrlFields && key === "url") {
    return startsWithDataUrl(item) && sanitizeInlineMediaDataUrl(item) !== undefined;
  }
  return sanitizeMediaDataUrlField(source, key, item) !== undefined;
}

export function shouldPreserveNestedTranscriptMediaDataUrlFields(
  source: Record<string, unknown>,
  key: string,
): boolean {
  return (
    (key === "image_url" &&
      (source.type === "image_url" || source.type === "input_image" || source.type === "image")) ||
    (key === "video_url" &&
      (source.type === "video_url" || source.type === "input_video" || source.type === "video"))
  );
}
