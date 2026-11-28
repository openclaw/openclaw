import { isPastedTextAttachment } from "../pasted-text-card.ts";
import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";

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
