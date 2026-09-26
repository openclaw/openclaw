import { mediaKindFromMime, type MediaKind } from "@openclaw/media-core/constants";
import { normalizeMimeType } from "@openclaw/media-core/mime";

export type ManagedMediaKind = Extract<MediaKind, "image" | "audio" | "video" | "document">;

const MANAGED_DOCUMENT_MIME_TYPES = new Set([
  "application/json",
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/x-cfb",
  "application/yaml",
  "application/zip",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
]);

export function resolveManagedMediaKind(contentType: string | undefined): ManagedMediaKind | null {
  const normalized = normalizeMimeType(contentType);
  if (normalized === "image/svg+xml") {
    return null;
  }
  const kind = mediaKindFromMime(normalized);
  if (kind === "image" || kind === "audio" || kind === "video") {
    return kind;
  }
  return normalized && MANAGED_DOCUMENT_MIME_TYPES.has(normalized) ? "document" : null;
}
