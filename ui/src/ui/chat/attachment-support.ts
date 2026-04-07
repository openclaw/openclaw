export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,application/pdf,text/*,.csv,.json,.md,.txt,.zip," +
  ".doc,.docx,.xls,.xlsx,.ppt,.pptx";

const CHAT_ATTACHMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.length > 0 && !mimeType.startsWith("video/");
}

export function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}

export function resolveSupportedChatAttachmentMimeType(file: {
  name?: string | null;
  type?: string | null;
}): string | null {
  const explicitType = file.type;
  if (typeof explicitType === "string" && explicitType.length > 0) {
    return isSupportedChatAttachmentMimeType(explicitType) ? explicitType : null;
  }
  const fileName = typeof file.name === "string" ? file.name.trim().toLowerCase() : "";
  if (fileName) {
    for (const [extension, mimeType] of Object.entries(CHAT_ATTACHMENT_EXTENSION_MIME_TYPES)) {
      if (fileName.endsWith(extension)) {
        return mimeType;
      }
    }
  }
  return isSupportedChatAttachmentFile({ name: fileName, type: explicitType ?? "" })
    ? "application/octet-stream"
    : null;
}
