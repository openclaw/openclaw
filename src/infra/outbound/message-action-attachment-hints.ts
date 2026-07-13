import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Collect media-source hints from normalized message attachments. */
export function collectMessageAttachmentMediaHints(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const mediaUrls: string[] = [];
  const seen = new Set<string>();
  const pushMedia = (entry: unknown) => {
    const normalized = normalizeOptionalString(entry);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    mediaUrls.push(normalized);
  };
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"] as const) {
      pushMedia(record[key]);
    }
  }
  return mediaUrls;
}
