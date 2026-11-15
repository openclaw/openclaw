import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayload } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";

export function currentAttachments(props: ChatAttachmentControlsProps): ChatAttachment[] {
  return props.getAttachments?.() ?? props.attachments ?? [];
}

export function removeDraftAttachment(
  attachment: ChatAttachment,
  props: ChatAttachmentControlsProps,
): void {
  const next = currentAttachments(props).filter((candidate) => candidate.id !== attachment.id);
  releaseChatAttachmentPayload(attachment.id);
  props.onAttachmentsChange?.(next);
}
