import { base64ToBytes } from "../../../lib/bytes-base64.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";
import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";

export function isPastedTextAttachment(
  attachment: Pick<ChatAttachment, "mimeType" | "fileName" | "origin">,
): boolean {
  const { mimeType, origin, fileName } = attachment;
  // Persisted history, drafts and outbox entries can predate explicit upload origins.
  return (
    mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain" &&
    (origin === "paste" || (origin === undefined && /^pasted-text-\d+\.txt$/.test(fileName ?? "")))
  );
}

export function isSentPastedTextAttachment(item: AssistantAttachmentItem): item is AttachmentItem {
  return (
    item.type === "attachment" &&
    item.attachment.kind === "document" &&
    isPastedTextAttachment({
      mimeType: item.attachment.mimeType ?? "",
      fileName: item.attachment.label,
      origin: item.attachment.origin,
    })
  );
}

function readTextFromDataUrl(dataUrl: string): string | null {
  const match = /^data:([^,]*),(.*)$/s.exec(dataUrl);
  if (!match) {
    return null;
  }
  const metadata = match[1]!;
  const payload = match[2]!;
  try {
    return metadata.toLowerCase().includes(";base64")
      ? new TextDecoder().decode(base64ToBytes(payload))
      : decodeURIComponent(payload.replace(/\+/g, "%20"));
  } catch {
    return null;
  }
}

/** Exact clipboard text of a pasted-text card, or null when its payload is unavailable. */
export function readPastedText(attachment: ChatAttachment): string | null {
  const dataUrl = getChatAttachmentDataUrl(attachment);
  return dataUrl ? readTextFromDataUrl(dataUrl) : null;
}

export function appendPastedTextToDraft(draft: string, text: string): string {
  if (!draft.trim()) {
    return text;
  }
  return `${draft.replace(/\s+$/u, "")}\n\n${text}`;
}

/**
 * Pasted-text cards are composer presentation only. Submission appends their exact
 * text to the sender's message, as "Show in text field" would, so a long paste keeps
 * the message's provenance, length and placement contract instead of uploading a file.
 */
export function foldPastedTextAttachments<T extends ChatAttachment>(
  message: string,
  attachments: readonly T[],
): { text: string; attachments: T[] } {
  let text = message;
  const remaining: T[] = [];
  for (const attachment of attachments) {
    const pasted = isPastedTextAttachment(attachment) ? readPastedText(attachment) : null;
    if (pasted === null) {
      remaining.push(attachment);
    } else {
      text = appendPastedTextToDraft(text, pasted);
    }
  }
  return { text, attachments: remaining };
}
