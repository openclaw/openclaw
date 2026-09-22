import type { ChatAttachment, ChatSelectionAnnotation } from "../../../lib/chat/chat-types.ts";
import {
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { encodeTextAsDataUrl } from "./chat-attachment-text.ts";

export function createChatSelectionAttachment(
  annotation: ChatSelectionAnnotation,
  limits?: ChatAttachmentControlsProps["attachmentLimits"],
): ChatAttachment | null {
  const text = [
    `Selected text:\n${annotation.text}`,
    ...(annotation.comment.trim() ? [`User comment:\n${annotation.comment}`] : []),
    [
      `Source session: ${annotation.sessionKey}`,
      ...(annotation.messageId ? [`Source message: ${annotation.messageId}`] : []),
      ...(annotation.entryId ? [`Source entry: ${annotation.entryId}`] : []),
      `Selected text UTF-16 length: ${annotation.text.length}`,
      `DOM text UTF-16 range: [${annotation.start}, ${annotation.end})`,
    ].join("\n"),
  ].join("\n\n");
  const file = new File([text], "selection-comment.txt", { type: "text/plain" });
  if (admitAttachmentFiles([file], limits).length === 0) {
    return null;
  }
  return registerChatAttachmentPayload({
    attachment: {
      id: generateAttachmentId(),
      mimeType: file.type,
      fileName: file.name,
      sizeBytes: file.size,
      selectionAnnotation: { ...annotation },
    },
    dataUrl: encodeTextAsDataUrl(text),
    file,
  });
}
