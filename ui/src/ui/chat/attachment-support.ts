export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

/**
 * Maximum file size for chat attachments (4 MB).
 * Files larger than this would produce base64 payloads that exceed the
 * WebSocket JSON-RPC frame limit and cause "Maximum call stack size exceeded".
 */
export const MAX_CHAT_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && !mimeType.startsWith("video/");
}

export function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type" | "size">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  if (/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name)) {
    return false;
  }
  if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
    return false;
  }
  return true;
}
