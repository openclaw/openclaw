import { readChatThreadMessageIdentity } from "../../lib/chat/history-message-identity.ts";
import { removePairingQrContent } from "../../lib/chat/pairing-qr.ts";
import {
  MAX_CHAT_THUMBNAILS,
  MAX_CHAT_THUMBNAIL_BYTES,
  MAX_CHAT_THUMBNAIL_SIZE,
} from "../../lib/chat/row-display-facts.ts";
import type { ChatSessionSnapshot } from "./session-message-cache.ts";

/** Display facts cannot outlive the transcript window they describe. */
export function projectChatRowDisplay(
  snapshot: ChatSessionSnapshot,
): ChatSessionSnapshot["rowDisplay"] {
  if (!snapshot.rowDisplay) {
    return undefined;
  }
  const rows: NonNullable<ChatSessionSnapshot["rowDisplay"]> = {};
  for (const message of snapshot.messages.slice(-80)) {
    const id = readChatThreadMessageIdentity(message)?.id;
    if (id && snapshot.rowDisplay[id] && removePairingQrContent(message) === message) {
      rows[id] = snapshot.rowDisplay[id]!;
    }
  }
  return Object.keys(rows).length === Object.keys(snapshot.rowDisplay).length
    ? snapshot.rowDisplay
    : rows;
}

export function chatThumbnailWeight(snapshot: Pick<ChatSessionSnapshot, "rowDisplay">) {
  let count = 0;
  let bytes = 0;
  for (const row of Object.values(snapshot.rowDisplay ?? {})) {
    for (const image of Object.values(row.images ?? {})) {
      if (image.thumbnail) {
        count++;
        bytes += image.thumbnail.size;
      }
    }
  }
  return { count, bytes };
}

export function boundChatThumbnails<S extends Pick<ChatSessionSnapshot, "rowDisplay">>(
  snapshot: S,
  budget = { count: MAX_CHAT_THUMBNAILS, bytes: MAX_CHAT_THUMBNAIL_BYTES },
): S {
  let rowDisplay = snapshot.rowDisplay;
  for (const [id, row] of Object.entries(rowDisplay ?? {}).toReversed()) {
    for (const [key, image] of Object.entries(row.images ?? {}).toReversed()) {
      const blob = image.thumbnail;
      if (!blob) {
        continue;
      }
      if (budget.count > 0 && blob.size <= budget.bytes && blob.size <= MAX_CHAT_THUMBNAIL_SIZE) {
        budget.count--;
        budget.bytes -= blob.size;
      } else {
        const { thumbnail: _thumbnail, ...dimensions } = image;
        rowDisplay = {
          ...rowDisplay,
          [id]: { ...row, images: { ...rowDisplay?.[id]?.images, [key]: dimensions } },
        };
      }
    }
  }
  return rowDisplay === snapshot.rowDisplay ? snapshot : { ...snapshot, rowDisplay };
}
