export const CHAT_ATTACHMENT_ACCEPT = "image/*, video/*, audio/*, application/pdf, text/*, application/json";

const SUPPORTED_MIME_PREFIXES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/",
  "application/json",
];

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string" || !mimeType) return false;
  return SUPPORTED_MIME_PREFIXES.some(prefix => mimeType.startsWith(prefix));
}
