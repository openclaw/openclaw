import type { AssistantAttachmentItem } from "./chat-message-media.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";

export function hasUserFileAttachments(attachments: readonly AssistantAttachmentItem[]): boolean {
  return attachments.some(
    (item) =>
      item.attachment.kind === "document" &&
      !isSentCommentAttachment(item) &&
      !isSentPastedTextAttachment(item),
  );
}
