export const CHAT_ATTACHMENT_ACCEPT = "image/*,application/pdf";

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return (
    typeof mimeType === "string" &&
    (mimeType.startsWith("image/") || mimeType === "application/pdf")
  );
}
