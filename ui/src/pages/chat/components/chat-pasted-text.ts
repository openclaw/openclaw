import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";
import "./chat-pasted-text.tsx";

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
