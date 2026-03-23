import type { MsgContext } from "../auto-reply/templating.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import { getFileExtension, isAudioFileName, kindFromMime } from "../media/mime.js";
import type { MediaAttachment } from "./types.js";

export function normalizeAttachmentPath(raw?: string | null): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (value.startsWith("file://")) {
    try {
      return safeFileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  try {
    assertNoWindowsNetworkPath(value, "Attachment path");
  } catch {
    return undefined;
  }
  return value;
}

export function normalizeAttachments(ctx: MsgContext): MediaAttachment[] {
  const pathsFromArray = Array.isArray(ctx.MediaPaths) ? ctx.MediaPaths : undefined;
  const urlsFromArray = Array.isArray(ctx.MediaUrls) ? ctx.MediaUrls : undefined;
  const typesFromArray = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : undefined;
  const resolveMime = (count: number, index: number) => {
    const typeHint = typesFromArray?.[index];
    const trimmed = typeof typeHint === "string" ? typeHint.trim() : "";
    if (trimmed) {
      return trimmed;
    }
    return count === 1 ? ctx.MediaType : undefined;
  };

  if (pathsFromArray && pathsFromArray.length > 0) {
    const count = pathsFromArray.length;
    const urls = urlsFromArray && urlsFromArray.length > 0 ? urlsFromArray : undefined;
    return pathsFromArray
      .map((value, index) => ({
        path: value?.trim() || undefined,
        url: urls?.[index] ?? ctx.MediaUrl,
        mime: resolveMime(count, index),
        index,
      }))
      .filter((entry) => Boolean(entry.path?.trim() || entry.url?.trim()));
  }

  if (urlsFromArray && urlsFromArray.length > 0) {
    const count = urlsFromArray.length;
    return urlsFromArray
      .map((value, index) => ({
        path: undefined,
        url: value?.trim() || undefined,
        mime: resolveMime(count, index),
        index,
      }))
      .filter((entry) => Boolean(entry.url?.trim()));
  }

  const pathValue = ctx.MediaPath?.trim();
  const url = ctx.MediaUrl?.trim();
  if (!pathValue && !url) {
    return [];
  }
  return [
    {
      path: pathValue || undefined,
      url: url || undefined,
      mime: ctx.MediaType,
      index: 0,
    },
  ];
}

export function resolveAttachmentKind(
  attachment: MediaAttachment,
): "image" | "audio" | "video" | "document" | "unknown" {
  const kind = kindFromMime(attachment.mime);
  if (kind === "image" || kind === "audio" || kind === "video") {
    return kind;
  }

  const ext = getFileExtension(attachment.path ?? attachment.url);
  if (!ext) {
    return "unknown";
  }
  if ([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"].includes(ext)) {
    return "video";
  }
  if (isAudioFileName(attachment.path ?? attachment.url)) {
    return "audio";
  }
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"].includes(ext)) {
    return "image";
  }
  return "unknown";
}

export function isVideoAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "video";
}

export function isAudioAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "audio";
}

export function isImageAttachment(attachment: MediaAttachment): boolean {
  return resolveAttachmentKind(attachment) === "image";
}
