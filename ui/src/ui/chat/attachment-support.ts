export const CHAT_ATTACHMENT_ACCEPT = "*/*";

const UNSUPPORTED_MIME_PREFIXES = ["video/"];

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  const normalizedMimeType = mimeType.trim().toLowerCase();
  return !UNSUPPORTED_MIME_PREFIXES.some((prefix) => normalizedMimeType.startsWith(prefix));
}
