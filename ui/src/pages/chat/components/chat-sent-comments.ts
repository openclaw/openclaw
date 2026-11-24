import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";

export function isSentCommentAttachment(item: AssistantAttachmentItem): item is AttachmentItem {
  return (
    item.type === "attachment" &&
    item.attachment.kind === "document" &&
    item.attachment.label === "selection-comment.txt" &&
    item.attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
  );
}
