import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";

const isImageMimeType = (value: unknown): value is string =>
  typeof value === "string" && /^image\//iu.test(value.trim());

const normalizeImageMimeType = (value: unknown): string | undefined =>
  isImageMimeType(value) ? value.trim().toLowerCase() : undefined;

function imageMimeTypeForRecord(value: Record<string, unknown>): string | undefined {
  return (
    normalizeImageMimeType(value.mimeType) ??
    normalizeImageMimeType(value.mediaType) ??
    normalizeImageMimeType(value.media_type)
  );
}

function imageMimeTypeFieldsForRecord(value: Record<string, unknown>): string[] {
  return ["mimeType", "mediaType", "media_type"].filter((key) => isImageMimeType(value[key]));
}

function sanitizeOpaqueImageBase64(
  base64: string,
  mimeType: string | undefined,
): { mimeType: string; base64: string } | undefined {
  return mimeType ? sanitizeInlineImageBase64({ mimeType, base64 }) : undefined;
}

export function sanitizeTranscriptImageRecord(
  source: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const isImageBlock = source.type === "image";
  const isBase64SourceBlock = source.type === "base64";
  if ((!isImageBlock && !isBase64SourceBlock) || typeof source.data !== "string") {
    return undefined;
  }
  const mimeTypeFields = imageMimeTypeFieldsForRecord(source);
  if (mimeTypeFields.length === 0) {
    return undefined;
  }
  const sanitized = sanitizeOpaqueImageBase64(source.data, imageMimeTypeForRecord(source));
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

export function sanitizeTranscriptImageDataUrlField({
  source,
  key,
  value,
  preserveImageDataUrlFields,
}: {
  source: Record<string, unknown>;
  key: string;
  value: string;
  preserveImageDataUrlFields: boolean;
}): string | undefined {
  if (!startsWithDataUrl(value)) {
    return undefined;
  }
  const isImageDataUrlField =
    (preserveImageDataUrlFields && key === "url") ||
    (source.type === "input_image" && key === "image_url") ||
    ((source.type === "image" || source.type === "image_url") && key === "url") ||
    (source.type === "image" && (key === "source" || key === "data"));
  return isImageDataUrlField ? sanitizeInlineImageDataUrlForStorage(value) : undefined;
}

export function shouldPreserveNestedTranscriptImageDataUrlFields(
  source: Record<string, unknown>,
  key: string,
): boolean {
  return (
    key === "image_url" &&
    (source.type === "image_url" || source.type === "input_image" || source.type === "image")
  );
}
