import type { ChatAttachment, ChatSelectionAnnotation } from "../../../lib/chat/chat-types.ts";
import {
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import { admitAttachmentFiles } from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { encodeTextAsDataUrl } from "./chat-attachment-text.ts";

export function formatChatSelectionAnnotation(annotation: ChatSelectionAnnotation): string {
  return [
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
}

export function createChatSelectionAttachment(
  annotation: ChatSelectionAnnotation,
  options: Pick<ChatAttachmentControlsProps, "attachmentLimits" | "selectionContextOnly"> = {},
  stagedBytes: number,
): ChatAttachment | null {
  const attachment = {
    id: generateAttachmentId(),
    mimeType: "text/plain",
    fileName: "selection-comment.txt",
    selectionAnnotation: { ...annotation },
  };
  if (options.selectionContextOnly) {
    return attachment;
  }
  const text = formatChatSelectionAnnotation(annotation);
  const file = new File([text], attachment.fileName, { type: attachment.mimeType });
  if (admitAttachmentFiles([file], options.attachmentLimits, stagedBytes).length === 0) {
    return null;
  }
  return registerChatAttachmentPayload({
    attachment: { ...attachment, sizeBytes: file.size },
    dataUrl: encodeTextAsDataUrl(text),
    file,
  });
}
