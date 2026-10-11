import { t } from "../../../i18n/index.ts";
import type { MessageContentItem } from "../../../lib/chat/chat-types.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import {
  AssistantAttachmentStatusCard,
  OmittedMedia,
  type AssistantAttachmentStatusCardProps,
} from "./chat-message-attachment-status-solid.tsx";

type OmittedMediaItem = Extract<MessageContentItem, { type: "omitted_media" }>;
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

export function renderOmittedMedia(items: OmittedMediaItem[]) {
  return solidContent(OmittedMedia, { items });
}
export function renderAssistantAttachmentStatusCard(params: AssistantAttachmentStatusCardProps) {
  return solidContent(AssistantAttachmentStatusCard, params);
}
