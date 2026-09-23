import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  setReplyPayloadMetadata,
} from "../../auto-reply/reply-payload.js";
import { normalizeMediaReferenceForComparison } from "../../media/media-reference-comparison.js";
import type { ReplyMediaAttachment, ReplyPayload } from "../../shared/reply-payload.types.js";

function mediaReferenceKeys(urls: readonly string[]): string[] {
  return [...new Set(urls.map(normalizeMediaReferenceForComparison).filter(Boolean))];
}

/** Record an accepted modifier decision without retaining a stale media snapshot. */
export function recordReplyPayloadMediaSelectionChange(
  previousMediaUrls: readonly string[],
  payload: ReplyPayload,
): ReplyPayload {
  const previous = mediaReferenceKeys(previousMediaUrls);
  const selected = mediaReferenceKeys(collectReplyMediaEntries(payload).map(({ url }) => url));
  return previous.length === selected.length &&
    previous.every((url, index) => url === selected[index])
    ? payload
    : setReplyPayloadMetadata(payload, { replyMediaSelectionChanged: true });
}

/** Recover media without undoing modifiers or duplicating a current prepared reference. */
export function preserveReplyPayloadMediaSelectionCore(
  source: ReplyPayload,
  recovered: ReplyPayload,
): ReplyPayload {
  const selectionChanged = getReplyPayloadMetadata(source)?.replyMediaSelectionChanged === true;
  const current = collectReplyMediaEntries(source);
  if (!selectionChanged && current.length === 0) {
    return recovered;
  }
  const aliases = new Set<string>();
  const seen = new Set<string>();
  const entries: ReturnType<typeof collectReplyMediaEntries> = [];
  const append = (entry: (typeof entries)[number]) => {
    const key = normalizeMediaReferenceForComparison(entry.url);
    if (key && !seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  };
  for (const entry of current) {
    append(entry);
    for (const alias of entry.sourceUrls ?? []) {
      aliases.add(normalizeMediaReferenceForComparison(alias));
    }
  }
  if (!selectionChanged) {
    for (const entry of collectReplyMediaEntries(recovered)) {
      if (!aliases.has(normalizeMediaReferenceForComparison(entry.url))) {
        append(entry);
      }
    }
  }
  const mediaUrls = entries.map(({ url }) => url);
  const payload = copyReplyPayloadMetadata(recovered, {
    ...recovered,
    mediaUrl: mediaUrls.length === 1 ? mediaUrls[0] : undefined,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    attachments: entries.some(({ attachment }) => attachment !== undefined)
      ? entries.map(({ attachment }) => attachment ?? {})
      : undefined,
  });
  return selectionChanged
    ? setReplyPayloadMetadata(payload, { replyMediaSelectionChanged: true })
    : payload;
}

/** Preserve attachment associations before media URLs are filtered or deduplicated. */
export function collectReplyMediaEntries(
  payload: Pick<ReplyPayload, "mediaUrls" | "mediaUrl" | "attachments">,
  projectedMediaUrls?: readonly string[],
): Array<{
  url: string;
  attachment: ReplyMediaAttachment | undefined;
  sourceUrls?: readonly string[];
}> {
  const sourcesByReference = getReplyPayloadMetadata(payload)?.replyMediaSourceUrls;
  const withSourceUrls = (entry: { url: string; attachment: ReplyMediaAttachment | undefined }) => {
    const sourceUrls = sourcesByReference?.get(normalizeMediaReferenceForComparison(entry.url));
    return sourceUrls?.length ? { ...entry, sourceUrls: [...sourceUrls] } : entry;
  };
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
    return mediaEntries.map(withSourceUrls);
  }
  const attachmentByUrl = new Map(attachmentByReference);
  for (const { url, attachment } of mediaEntries) {
    const key = normalizeMediaReferenceForComparison(url);
    if (key && attachment && !attachmentByUrl.has(key)) {
      attachmentByUrl.set(key, attachment);
    }
  }
  return projectedMediaUrls.map((url) =>
    withSourceUrls({
      url,
      attachment: attachmentByUrl.get(normalizeMediaReferenceForComparison(url)),
    }),
  );
}
