import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 0) {
    return null;
  }
  // FileReader may include MIME parameters. Validate metadata separately from
  // the payload, so neither repeated parameters nor image bytes need a capture regex.
  const [mimeType, ...parameters] = dataUrl.slice(5, commaIndex).split(";");
  if (
    !mimeType ||
    parameters.pop() !== "base64" ||
    parameters.some((parameter) => !/^[^=]+=[\s\S]*$/.test(parameter))
  ) {
    return null;
  }
  const content = dataUrl.slice(commaIndex + 1);
  return content && !/[\r\n\u2028\u2029]/.test(content) ? { mimeType, content } : null;
}

/** Converts composer attachments into the base64 payload accepted by chat.send. */
export function buildChatApiAttachments(attachments?: readonly ChatAttachment[]) {
  return attachments?.length
    ? attachments.map((attachment) => {
        const dataUrl = getChatAttachmentDataUrl(attachment);
        const parsed = dataUrl ? dataUrlToBase64(dataUrl) : null;
        if (!parsed) {
          throw new Error(t("chat.sendErrors.outboxPayloadMissing"));
        }
        return {
          type: parsed.mimeType.startsWith("image/") ? "image" : "file",
          mimeType: parsed.mimeType,
          fileName: attachment.fileName,
          content: parsed.content,
        };
      })
    : undefined;
}

/** Restores durable first-turn payloads into visible, locked composer chips. */
export function restoreChatApiAttachments(attachments?: readonly unknown[]): ChatAttachment[] {
  if (!attachments?.length) {
    return [];
  }
  return attachments.flatMap((value) => {
    if (!value || typeof value !== "object") {
      return [];
    }
    const attachment = value as Record<string, unknown>;
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim() : "";
    const content = typeof attachment.content === "string" ? attachment.content : "";
    if (
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType) ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(content)
    ) {
      return [];
    }
    return [
      {
        id: generateUUID(),
        dataUrl: `data:${mimeType};base64,${content}`,
        mimeType,
        fileName: typeof attachment.fileName === "string" ? attachment.fileName : undefined,
      },
    ];
  });
}
