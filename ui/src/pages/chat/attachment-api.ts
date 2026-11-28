import { HEADERLESS_CSV_MIME_TYPE, isHeaderlessCsvMime } from "@openclaw/media-core/mime";
import { t } from "../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../i18n/locales/en-chat-composer.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";

registerChatComposerEnglish();

function dataUrlToBase64(dataUrl: string): { content: string; mimeType: string } | null {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  // FileReader may include MIME parameters. Validate metadata separately from
  // the payload, so neither repeated parameters nor image bytes need a capture regex.
  const metadata = dataUrl.slice(0, commaIndex);
  const mimeType = /^data:([^;]+)(?:;[^=;]+=[^;]*)*;base64$/.exec(metadata)?.[1];
  const content = dataUrl.slice(commaIndex + 1);
  return mimeType && content && !/[\r\n\u2028\u2029]/.test(content)
    ? {
        mimeType: isHeaderlessCsvMime(metadata.slice(5)) ? HEADERLESS_CSV_MIME_TYPE : mimeType,
        content,
      }
    : null;
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
          ...(attachment.origin ? { origin: attachment.origin } : {}),
          content: parsed.content,
        };
      })
    : undefined;
}
