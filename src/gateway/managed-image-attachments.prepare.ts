import path from "node:path";
import { sanitizeUntrustedFileName } from "@openclaw/fs-safe/advanced";
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import type { ReplyMediaAttachment, ReplyPayload } from "../auto-reply/reply-payload.js";
import { collectReplyMediaEntries } from "../infra/outbound/reply-media-entries.js";

export type PreparedOutgoingMedia = {
  url: string;
  filename?: string;
  mimeType?: string;
  trustedLocal: boolean;
  durationMs?: number;
  width?: number;
  height?: number;
};

export function toRecordFilename(
  filePath: string,
  attachmentName?: string,
  fallbackName?: string,
  contentType?: string,
) {
  const fallback = fallbackName ?? path.basename(filePath).trim();
  if (!attachmentName?.trim()) {
    return fallback || null;
  }
  const safeName = sanitizeUntrustedFileName(attachmentName, fallback);
  const extension =
    contentType === "application/octet-stream" || mimeTypeFromFilePath(safeName) === contentType
      ? path.extname(safeName)
      : path.extname(filePath);
  return `${path.parse(safeName).name}${extension}`;
}

export function prepareOutgoingMediaFromReplyPayload(
  payload: ReplyPayload,
  metadataSource: ReplyPayload = payload,
): PreparedOutgoingMedia[] {
  const metadataByUrl = new Map<string, ReplyMediaAttachment>();
  for (const entry of collectReplyMediaEntries(metadataSource)) {
    const key = entry.url.trim();
    if (key && entry.attachment && !metadataByUrl.has(key)) {
      metadataByUrl.set(key, entry.attachment);
    }
  }
  const seen = new Set<string>();
  return collectReplyMediaEntries(payload).flatMap((entry) => {
    const key = entry.url.trim();
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    const attachment = metadataByUrl.get(key) ?? entry.attachment;
    return [
      {
        url: entry.url,
        ...(attachment?.name ? { filename: attachment.name } : {}),
        ...(attachment?.mimeType ? { mimeType: attachment.mimeType } : {}),
        trustedLocal: attachment?.trustedLocalMedia ?? payload.trustedLocalMedia === true,
        ...(attachment?.durationMs !== undefined ? { durationMs: attachment.durationMs } : {}),
        ...(attachment?.width !== undefined ? { width: attachment.width } : {}),
        ...(attachment?.height !== undefined ? { height: attachment.height } : {}),
      },
    ];
  });
}
