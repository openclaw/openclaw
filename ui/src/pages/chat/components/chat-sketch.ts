import { uploadsEnabled } from "../../../lib/uploads.ts";
import { releaseChatAttachmentPayload } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { currentAttachments } from "./chat-attachment-draft.ts";
import { chatAttachmentFromDataUrl, stagedAttachmentBytes } from "./chat-attachments.ts";

export function attachChatSketch(dataUrl: string, props: ChatAttachmentControlsProps): boolean {
  if (
    props.disabled ||
    props.cameraActive === false ||
    props.readSignal?.aborted ||
    !props.onAttachmentsChange ||
    !uploadsEnabled(props.uploadConfig)
  ) {
    return false;
  }
  const attachment = chatAttachmentFromDataUrl(
    dataUrl,
    "sketch.png",
    props.attachmentLimits,
    stagedAttachmentBytes(props),
  );
  if (!attachment) {
    return false;
  }
  let accepted = false;
  try {
    accepted = props.onAttachmentsChange([...currentAttachments(props), attachment]) !== false;
    return accepted;
  } finally {
    if (!accepted) {
      releaseChatAttachmentPayload(attachment.id);
    }
  }
}
