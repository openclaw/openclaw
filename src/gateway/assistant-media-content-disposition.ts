import { toUSVString } from "node:util";
import { basenameFromAnyPath } from "@openclaw/media-core/file-name";
import { kindFromMime } from "@openclaw/media-core/mime";

export function resolveAssistantMediaFilename(
  fallback: string,
  filenameHint: string | null,
): string {
  return basenameFromAnyPath(filenameHint ?? "") || fallback;
}

export function buildAssistantMediaContentDisposition(filename: string, mime?: string): string {
  // Keep the RFC 6266 fallback ASCII; filename* carries the exact UTF-8 name.
  const sanitizedInput = truncateFilenamePreservingExtension(
    toUSVString(filename.replace(/[\r\n]/g, "_")),
  );
  const fallback = sanitizedInput.replace(/[^\x20-\x7e]|[%"\\]/g, "_").trim() || "download";
  const extended = encodeURIComponent(sanitizedInput).replace(
    /[\x27()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const kind = kindFromMime(mime);
  const inline = kind === "image" || kind === "audio" || kind === "video";
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${extended}`;
}

export function buildManagedMediaContentDisposition(
  value: string | null,
  contentType: string,
): string {
  const fallback = contentType.startsWith("image/") ? "generated-image" : "generated-media";
  return buildAssistantMediaContentDisposition(value?.trim() || fallback, contentType);
}

function truncateFilenamePreservingExtension(value: string): string {
  const maxCodePoints = 200;
  const chars = Array.from(value);
  if (chars.length <= maxCodePoints) {
    return value;
  }
  const lastDot = chars.lastIndexOf(".");
  // Preserve normal save-dialog type hints without retaining an oversized suffix.
  const extension =
    lastDot > 0 && lastDot < chars.length - 1 && chars.length - lastDot <= 32
      ? chars.slice(lastDot)
      : [];
  if (extension.length === 0) {
    return chars.slice(0, maxCodePoints).join("");
  }
  return `${chars.slice(0, maxCodePoints - extension.length).join("")}${extension.join("")}`;
}
