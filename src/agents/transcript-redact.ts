/**
 * Agent transcript redaction helpers.
 *
 * Applies logging redaction rules to persisted messages while preserving unchanged object identity.
 */
import { Buffer } from "node:buffer";
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
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

function isImageMimeType(value: unknown): boolean {
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

function base64HasImageSignature(base64: string, mimeType: string): boolean {
  const canonical = canonicalizeBase64(base64);
  if (!canonical) {
    return false;
  }
  const header = Buffer.from(canonical.slice(0, 64), "base64");
  if (mimeType === "image/png") {
    return header
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  }
  if (mimeType === "image/gif") {
    return (
      header.subarray(0, 6).equals(Buffer.from("GIF87a")) ||
      header.subarray(0, 6).equals(Buffer.from("GIF89a"))
    );
  }
  if (mimeType === "image/webp") {
    return (
      header.subarray(0, 4).equals(Buffer.from("RIFF")) &&
      header.subarray(8, 12).equals(Buffer.from("WEBP"))
    );
  }
  if (mimeType === "image/bmp") {
    return header.subarray(0, 2).equals(Buffer.from("BM"));
  }
  return false;
}

function isValidOpaqueImageBase64(base64: string, mimeType: string | undefined): boolean {
  return mimeType !== undefined && base64HasImageSignature(base64, mimeType);
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

function imageDataUrlPayload(value: string): { mimeType: string; base64: string } | undefined {
  const trimmed = value.trimStart();
  if (!trimmed.toLowerCase().startsWith("data:")) {
    return undefined;
  }
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex < 0) {
    return undefined;
  }
  const header = trimmed.slice("data:".length, commaIndex);
  const [rawMimeType, ...metadata] = header.split(";");
  const mimeType = rawMimeType.trim().toLowerCase();
  if (
    !isImageMimeType(mimeType) ||
    !metadata.some((part) => part.trim().toLowerCase() === "base64")
  ) {
    return undefined;
  }
  return {
    mimeType,
    base64: trimmed.slice(commaIndex + 1),
  };
}

function isImageDataUrlField(source: Record<string, unknown>, key: string, value: string): boolean {
  const parsed = imageDataUrlPayload(value);
  if (!parsed || !isValidOpaqueImageBase64(parsed.base64, parsed.mimeType)) {
    return false;
  }
  if (source.type === "input_image" && key === "image_url") {
    return true;
  }
  if ((source.type === "image" || source.type === "image_url") && key === "url") {
    return true;
  }
  return source.type === "image" && (key === "source" || key === "data");
}

function isValidImageDataUrl(value: string): boolean {
  const parsed = imageDataUrlPayload(value);
  return Boolean(parsed && isValidOpaqueImageBase64(parsed.base64, parsed.mimeType));
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
    return isValidImageDataUrl(item);
  }
  return isImageDataUrlField(source, key, item);
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
  const source = value;
  let next: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(source)) {
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
