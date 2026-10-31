import { normalizeMessage } from "../../../lib/chat/message-normalizer.ts";
import type { readChatTranscriptAttachmentSource } from "../chat-history-state.ts";
import { resolveCappedMessageId } from "../chat-message-recovery.ts";
import { buildMessageItems } from "../chat-thread-items.ts";
import { imageTitle } from "./chat-image-presentation.ts";
import {
  createMessageMediaOptions,
  type MessageMediaOptions,
} from "./chat-message-bubble-presentation.ts";
import { projectMessageMedia } from "./chat-message-media.ts";
import type {
  TranscriptAttachmentEntry,
  TranscriptAttachments,
  SidebarContent,
} from "./chat-sidebar-content-types.ts";

/** Projects only the adopted window, preserving message and media slot identities. */
export function projectTranscriptAttachments(
  source: ReturnType<typeof readChatTranscriptAttachmentSource>,
  options: MessageMediaOptions,
  onOpenSidebar: (content: SidebarContent) => void,
): TranscriptAttachments {
  const entries: TranscriptAttachmentEntry[] = [];
  const pairingQrExpirations: { messageKey: string; nextPairingQrExpiresAt: number }[] = [];
  let omittedMedia = false;
  for (const row of buildMessageItems(source.messages)) {
    const normalized = normalizeMessage(row.message);
    omittedMedia ||=
      normalized.content.some((item) => item.type === "omitted_media") ||
      Boolean(resolveCappedMessageId(row.message, normalized.role));
    const media = projectMessageMedia(row.message, normalized.content);
    if (media.nextPairingQrExpiresAt !== undefined) {
      pairingQrExpirations.push({
        messageKey: row.key,
        nextPairingQrExpiresAt: media.nextPairingQrExpiresAt,
      });
    }
    const nativeOptions = createMessageMediaOptions(
      row.message,
      row.key,
      {
        ...options,
        sessionKey: source.sessionKey,
        connectionEpoch: source.connectionEpoch,
      },
      media,
    );
    for (const [index, image] of media.images.entries()) {
      entries.push({
        kind: "image",
        image,
        options: nativeOptions,
        onOpenSidebar,
        key: JSON.stringify([
          source.sessionKey,
          source.sessionId,
          row.key,
          "image",
          image.factIndex === undefined ? "slot" : "fact",
          image.factIndex ?? index,
        ]),
        label: imageTitle(image),
        mimeType: image.mimeType,
      });
    }
    for (const [index, item] of media.attachments.entries()) {
      entries.push({
        kind: "attachment",
        item,
        options: nativeOptions,
        onOpenSidebar,
        key: JSON.stringify([
          source.sessionKey,
          source.sessionId,
          row.key,
          item.type,
          item.type === "attachment" ? item.attachment.url : index,
        ]),
        label: item.attachment.label,
        mimeType: item.attachment.mimeType,
      });
    }
  }
  return {
    pairingQrExpirations,
    mediaOwner: options.mediaOwner,
    refresh: () => projectTranscriptAttachments(source, options, onOpenSidebar),
    entries,
    coverage: source.coverage === "complete" && omittedMedia ? "partial" : source.coverage,
    loading: source.loading,
    error: source.error,
    omittedMedia,
  };
}

export function transcriptAttachmentMatches(entry: TranscriptAttachmentEntry, query: string) {
  return entry.label
    .toLowerCase()
    .normalize("NFC")
    .includes(query.trim().toLowerCase().normalize("NFC"));
}

export function hasTranscriptAttachments(source: TranscriptAttachments | undefined, query = "") {
  return Boolean(
    source &&
    (source.entries.some((entry) => transcriptAttachmentMatches(entry, query)) ||
      source.coverage !== "complete" ||
      source.omittedMedia ||
      source.loading ||
      source.error),
  );
}
