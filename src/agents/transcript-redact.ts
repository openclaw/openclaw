/**
 * Agent transcript redaction helpers.
 *
 * Applies logging redaction rules to persisted messages while preserving unchanged object identity.
 */
import {
  sanitizeInlineImageBase64,
  sanitizeInlineImageDataUrlForStorage,
} from "@openclaw/media-core/inline-image-data-url";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readLoggingConfig } from "../logging/config.js";
import {
  getDefaultRedactPatterns,
  redactSensitiveFieldValue,
  redactSensitiveText,
} from "../logging/redact.js";
import type { AgentMessage } from "./runtime/index.js";

function resolveTranscriptRedactPatterns(patterns?: string[]) {
  return patterns && patterns.length > 0 ? [...patterns, ...getDefaultRedactPatterns()] : undefined;
}

function redactTranscriptOptions(cfg?: OpenClawConfig) {
  const configuredLogging = readLoggingConfig();
  const mode = cfg?.logging?.redactSensitive ?? configuredLogging?.redactSensitive;
  const patterns = resolveTranscriptRedactPatterns(
    cfg?.logging?.redactPatterns ?? configuredLogging?.redactPatterns,
  );
  if (mode === undefined && patterns === undefined) {
    return undefined;
  }
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(patterns !== undefined ? { patterns } : {}),
  };
}

function redactTranscriptText(value: string, cfg?: OpenClawConfig): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveText(value, redactTranscriptOptions(cfg));
}

function redactTranscriptStructuredFieldValue(
  key: string,
  value: string,
  cfg?: OpenClawConfig,
): string {
  if (cfg?.logging?.redactSensitive === "off") {
    return value;
  }
  return redactSensitiveFieldValue(key, value, redactTranscriptOptions(cfg));
}

function isPlainTranscriptObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isImageMimeType(value: unknown): value is string {
  return typeof value === "string" && /^image\//iu.test(value.trim());
}

function normalizeImageMimeType(value: unknown): string | undefined {
  return isImageMimeType(value) ? value.trim().toLowerCase() : undefined;
}

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

function isValidOpaqueImageBase64(base64: string, mimeType: string | undefined): boolean {
  return sanitizeOpaqueImageBase64(base64, mimeType) !== undefined;
}

function isTranscriptImageContentBlock(value: Record<string, unknown>): boolean {
  return (
    value.type === "image" &&
    typeof value.data === "string" &&
    isValidOpaqueImageBase64(value.data, imageMimeTypeForRecord(value))
  );
}

function isImageBase64SourceBlock(value: Record<string, unknown>): boolean {
  return (
    value.type === "base64" &&
    typeof value.data === "string" &&
    isValidOpaqueImageBase64(value.data, imageMimeTypeForRecord(value))
  );
}

function sanitizeImageRecord(source: Record<string, unknown>): Record<string, unknown> | undefined {
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

function sanitizeImageDataUrlField(
  source: Record<string, unknown>,
  key: string,
  value: string,
): string | undefined {
  if (!startsWithDataUrl(value)) {
    return undefined;
  }
  const isImageDataUrlField =
    (source.type === "input_image" && key === "image_url") ||
    ((source.type === "image" || source.type === "image_url") && key === "url") ||
    (source.type === "image" && (key === "source" || key === "data"));
  return isImageDataUrlField ? sanitizeInlineImageDataUrlForStorage(value) : undefined;
}

function shouldPreserveOpaqueImagePayload(
  source: Record<string, unknown>,
  key: string,
  item: unknown,
  preserveImageDataUrlFields: boolean,
): boolean {
  if (typeof item !== "string") {
    return false;
  }
  if (
    key === "data" &&
    (isTranscriptImageContentBlock(source) || isImageBase64SourceBlock(source))
  ) {
    return true;
  }
  if (preserveImageDataUrlFields && key === "url") {
    return startsWithDataUrl(item) && sanitizeInlineImageDataUrlForStorage(item) !== undefined;
  }
  return sanitizeImageDataUrlField(source, key, item) !== undefined;
}

function shouldPreserveNestedImageDataUrlFields(
  source: Record<string, unknown>,
  key: string,
): boolean {
  return (
    key === "image_url" &&
    (source.type === "image_url" || source.type === "input_image" || source.type === "image")
  );
}

function redactTranscriptStructuredValue(
  value: unknown,
  cfg?: OpenClawConfig,
  fieldKey?: string,
  seen: WeakSet<object> = new WeakSet<object>(),
  preserveImageDataUrlFields = false,
): unknown {
  if (typeof value === "string") {
    if (fieldKey) {
      return redactTranscriptStructuredFieldValue(fieldKey, value, cfg);
    }
    return redactTranscriptText(value, cfg);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    let changed = false;
    const redacted = value.map((item) => {
      const next = redactTranscriptStructuredValue(
        item,
        cfg,
        fieldKey,
        seen,
        preserveImageDataUrlFields,
      );
      changed ||= next !== item;
      return next;
    });
    seen.delete(value);
    return changed ? redacted : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    // Avoid recursive transcript payloads from escaping redaction or crashing
    // persistence; circular refs serialize as a stable marker.
    return "[Circular]";
  }
  if (!isPlainTranscriptObject(value)) {
    // Non-plain instances can carry runtime state; leave them untouched instead
    // of cloning unexpected prototypes into transcripts.
    return value;
  }

  seen.add(value);
  const sanitizedImageRecord = sanitizeImageRecord(value);
  const source = sanitizedImageRecord ?? value;
  let next: Record<string, unknown> | null = null;
  if (source !== value) {
    next = { ...source };
  }
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === "string") {
      const sanitizedDataUrl =
        preserveImageDataUrlFields && key === "url"
          ? startsWithDataUrl(item)
            ? sanitizeInlineImageDataUrlForStorage(item)
            : undefined
          : sanitizeImageDataUrlField(source, key, item);
      if (sanitizedDataUrl !== undefined) {
        if (sanitizedDataUrl !== item) {
          next ??= { ...source };
          next[key] = sanitizedDataUrl;
        }
        continue;
      }
    }
    if (shouldPreserveOpaqueImagePayload(source, key, item, preserveImageDataUrlFields)) {
      continue;
    }
    const redacted = redactTranscriptStructuredValue(
      item,
      cfg,
      key,
      seen,
      preserveImageDataUrlFields || shouldPreserveNestedImageDataUrlFields(source, key),
    );
    if (redacted === item) {
      continue;
    }
    next ??= { ...source };
    next[key] = redacted;
  }
  seen.delete(value);
  return next ?? value;
}

/** Return a redacted transcript message according to logging config. */
export function redactTranscriptMessage(message: AgentMessage, cfg?: OpenClawConfig): AgentMessage {
  if (cfg?.logging?.redactSensitive === "off") {
    return message;
  }
  return redactTranscriptStructuredValue(message, cfg) as AgentMessage;
}
