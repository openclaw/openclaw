import { t } from "../../../i18n/index.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
type AttachmentFailureCode = Extract<
  MessageContentItem,
  { type: "attachment_error" }
>["attachment"]["code"];

export function attachmentFailureReason(code: AttachmentFailureCode): string {
  return code === "file-not-found"
    ? t("chat.attachments.failureFileNotFound")
    : code === "unsupported-format"
      ? t("chat.attachments.failureUnsupportedFormat")
      : code === "invalid-reference"
        ? t("chat.attachments.failureInvalidReference")
        : t("chat.attachments.failureDeliveryFailed");
}
