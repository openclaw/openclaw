import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import type { ReplyMediaAttachment, ReplyPayload } from "../../shared/reply-payload.types.js";

/** Preserve attachment associations before media URLs are filtered or deduplicated. */
export function collectReplyMediaEntries(
  payload: Pick<ReplyPayload, "mediaUrls" | "mediaUrl" | "attachments">,
  projectedMediaUrls?: readonly string[],
) {
  const attachmentByReference = new Map<string, ReplyMediaAttachment>();
  const positionalAttachments: Array<ReplyMediaAttachment | undefined> = [];
  for (const attachment of payload.attachments ?? []) {
    const reference = normalizeMediaReferenceForComparison(
      attachment.path ?? attachment.url ?? attachment.mediaUrl ?? attachment.filePath ?? "",
    );
    if (reference && !attachmentByReference.has(reference)) {
      attachmentByReference.set(reference, attachment);
    }
    // Compact referenced records do not identify other media through their array positions.
    positionalAttachments.push(reference ? undefined : attachment);
  }
  const mediaUrlCount = payload.mediaUrls?.length ?? 0;
  const mediaEntries = [
    ...(payload.mediaUrls ?? []).map((url, index) => ({
      url,
      attachment:
        attachmentByReference.get(normalizeMediaReferenceForComparison(url)) ??
        positionalAttachments[index],
    })),
    ...(typeof payload.mediaUrl === "string"
      ? [
          {
            url: payload.mediaUrl,
            attachment:
              attachmentByReference.get(normalizeMediaReferenceForComparison(payload.mediaUrl)) ??
              positionalAttachments[mediaUrlCount],
          },
        ]
      : []),
  ];
  if (!projectedMediaUrls) {
    return mediaEntries;
  }
  const attachmentByUrl = new Map(attachmentByReference);
  for (const { url, attachment } of mediaEntries) {
    const key = normalizeMediaReferenceForComparison(url);
    if (key && attachment && !attachmentByUrl.has(key)) {
      attachmentByUrl.set(key, attachment);
    }
  }
  return projectedMediaUrls.map((url) => ({
    url,
    attachment: attachmentByUrl.get(normalizeMediaReferenceForComparison(url)),
  }));
}
