// Control UI chat module implements attachment support behavior.
export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

export function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}
