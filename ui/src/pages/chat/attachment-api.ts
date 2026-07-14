import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) {
    return null;
  }
  const mimeType = match[1];
  const content = match[2];
  return mimeType && content ? { mimeType, content } : null;
}

/** Converts composer attachments into the base64 payload accepted by chat.send. */
export function buildChatApiAttachments(attachments?: readonly ChatAttachment[]) {
  return attachments?.length
    ? attachments
        .map((attachment) => {
          const dataUrl = getChatAttachmentDataUrl(attachment);
          const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
          if (!parsed) {
            return null;
          }
          return {
            type: parsed.mimeType.startsWith("image/") ? "image" : "file",
            mimeType: parsed.mimeType,
            fileName: attachment.fileName,
            content: parsed.content,
          };
        })
        .filter((attachment): attachment is NonNullable<typeof attachment> => attachment !== null)
    : undefined;
}
