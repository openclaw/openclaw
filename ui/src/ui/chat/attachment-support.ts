export const CHAT_ATTACHMENT_ACCEPT = "image/*";

const CHAT_ATTACHMENT_EXTENSION_MIME_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  return typeof mimeType === "string" && mimeType.startsWith("image/");
}

export function resolveSupportedChatAttachmentMimeType(file: {
  name?: string | null;
  type?: string | null;
}): string | null {
  if (typeof file.type === "string") {
    const mimeType = file.type.trim();
    if (mimeType.length > 0) {
      return isSupportedChatAttachmentMimeType(mimeType) ? mimeType : null;
    }
  }
  const fileName = typeof file.name === "string" ? file.name.trim().toLowerCase() : "";
  if (!fileName) {
    return null;
  }
  for (const [extension, mimeType] of Object.entries(CHAT_ATTACHMENT_EXTENSION_MIME_TYPES)) {
    if (fileName.endsWith(extension)) {
      return mimeType;
    }
  }
  return null;
}
