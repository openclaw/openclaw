import { isManagedOutgoingMediaSource } from "./chat-message-attachment-availability.ts";
import { isLocalAssistantAttachmentSource } from "./chat-message-local-media.ts";
import { resolveAttachmentImageKind, type AttachmentItem } from "./chat-message-media.ts";

export function needsAttachmentSourceAdmission(attachment: AttachmentItem["attachment"]): boolean {
  return (
    isLocalAssistantAttachmentSource(attachment.url) || isManagedOutgoingMediaSource(attachment.url)
  );
}

export function shouldDeferAttachmentCard(
  item: AttachmentItem,
  presentation: "inline" | "card" | "preview",
): boolean {
  const { attachment } = item;
  // Players and SVG previews retain their own control lifetimes.
  return (
    needsAttachmentSourceAdmission(attachment) &&
    resolveAttachmentImageKind(attachment) !== "svg" &&
    !(presentation === "inline" && (attachment.kind === "audio" || attachment.kind === "video")) &&
    !(presentation === "preview" && attachment.kind === "video")
  );
}

export type AttachmentAdmission = {
  observeElement?: (element: Element | undefined) => void;
  onAdmit: () => void;
};
