import { solidContent } from "../../../lit/solid-content.tsx";
import { AssistantAttachments, MessageAttachment } from "./chat-message-attachments-solid.tsx";
import type { AssistantAttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";
import { isSentPastedTextAttachment } from "./chat-pasted-text.ts";
import { isSentCommentAttachment } from "./chat-sent-comments.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

export function hasUserFileAttachments(attachments: readonly AssistantAttachmentItem[]): boolean {
  return attachments.some(
    (item) =>
      item.attachment.kind === "document" &&
      !isSentCommentAttachment(item) &&
      !isSentPastedTextAttachment(item),
  );
}

export function renderAssistantAttachments(
  attachments: AssistantAttachmentItem[],
  options: ImageRenderOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
  onAssistantAttachmentLoaded?: () => void,
  inlinePlayback = true,
) {
  return solidContent(AssistantAttachments, {
    attachments,
    options,
    onOpenSidebar,
    onAssistantAttachmentLoaded,
    inlinePlayback,
  });
}

export function renderMessageAttachment(
  item: AssistantAttachmentItem,
  options: ImageRenderOptions,
  onOpenSidebar?: (content: SidebarContent) => void,
  onAssistantAttachmentLoaded?: () => void,
  presentation: "inline" | "card" | "preview" = "inline",
) {
  return solidContent(MessageAttachment, {
    item,
    options,
    onOpenSidebar,
    onAssistantAttachmentLoaded,
    presentation,
  });
}
