import path from "node:path";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import type { MediaFactInput } from "../media/media-facts.js";
import type { PersistedUserTurnMediaInput } from "./user-turn-transcript.types.js";

const URL_LIKE_MEDIA_PATH_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const STRUCTURED_MEDIA_KINDS = new Set<NonNullable<MediaFactInput["kind"]>>([
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "unknown",
]);

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function mediaTypeForTranscript(media: PersistedUserTurnMediaInput, mediaPath?: string): string {
  return (
    normalizeOptionalText(media.contentType) ??
    normalizeOptionalText(media.kind) ??
    mimeTypeFromFilePath(mediaPath) ??
    "application/octet-stream"
  );
}

function normalizeStructuredMediaKind(value: string | null | undefined): MediaFactInput["kind"] {
  const kind = normalizeOptionalText(value);
  return kind && STRUCTURED_MEDIA_KINDS.has(kind as NonNullable<MediaFactInput["kind"]>)
    ? (kind as NonNullable<MediaFactInput["kind"]>)
    : undefined;
}

export function resolveTranscriptMediaPath(
  pathValue: string,
  workspaceDir: string | undefined,
): string {
  // Relative staged media paths are anchored to the media workspace; absolute
  // paths and URL-like refs are already stable transcript references.
  if (!workspaceDir || path.isAbsolute(pathValue) || URL_LIKE_MEDIA_PATH_PATTERN.test(pathValue)) {
    return pathValue;
  }
  return path.join(workspaceDir, pathValue);
}

export function normalizeMediaEntryForTranscript(
  media: PersistedUserTurnMediaInput,
): MediaFactInput {
  const rawPath = normalizeOptionalText(media.path) ?? normalizeOptionalText(media.url);
  if (!rawPath) {
    return media.hydrationSuppressed === true
      ? {
          contentType: normalizeOptionalText(media.contentType),
          hydrationSuppressed: true,
        }
      : {};
  }
  return {
    path: resolveTranscriptMediaPath(rawPath, normalizeOptionalText(media.workspaceDir)),
    contentType: mediaTypeForTranscript(media, rawPath),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
}

export function normalizeStructuredMediaEntryForTranscript(
  media: PersistedUserTurnMediaInput,
): MediaFactInput {
  const mediaPath = normalizeOptionalText(media.path);
  const mediaUrl = normalizeOptionalText(media.url);
  return {
    path: mediaPath,
    url: mediaUrl,
    contentType:
      normalizeOptionalText(media.contentType) ?? mimeTypeFromFilePath(mediaPath ?? mediaUrl),
    kind: normalizeStructuredMediaKind(media.kind),
    workspaceDir: normalizeOptionalText(media.workspaceDir),
    ...(media.hydrationSuppressed === true ? { hydrationSuppressed: true } : {}),
  };
}

export function shouldPersistStructuredMediaEntries(
  media: readonly PersistedUserTurnMediaInput[] | null | undefined,
): boolean {
  return (media ?? []).some((entry) => {
    const legacy = normalizeMediaEntryForTranscript(entry);
    const structured = normalizeStructuredMediaEntryForTranscript(entry);
    const structuredIdentity = structured.path ?? structured.url;
    return (
      structured.hydrationSuppressed === true ||
      structuredIdentity !== legacy.path ||
      Boolean(structured.url && structured.url !== legacy.path)
    );
  });
}
