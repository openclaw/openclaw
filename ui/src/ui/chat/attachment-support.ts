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
  if (typeof mimeType !== "string") {
    return false;
  }
  const normalized = mimeType.trim();
  return normalized.length > 0 && !normalized.startsWith("video/");
}

export function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  if (file.type.startsWith("video/")) {
    return false;
  }
  return !/\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i.test(file.name);
}

function resolveImageExtensionMimeType(fileName: string): string | null {
  for (const [extension, mimeType] of Object.entries(CHAT_ATTACHMENT_EXTENSION_MIME_TYPES)) {
    if (fileName.endsWith(extension)) {
      return mimeType;
    }
  }
  return null;
}

export function resolveSupportedChatAttachmentMimeType(file: {
  name?: string | null;
  type?: string | null;
}): string | null {
  const fileName = typeof file.name === "string" ? file.name.trim().toLowerCase() : "";
  if (typeof file.type === "string") {
    const mimeType = file.type.trim();
    if (mimeType.length > 0) {
      if (!isSupportedChatAttachmentFile({ name: fileName, type: mimeType })) {
        return null;
      }
      if (!mimeType.startsWith("image/") && resolveImageExtensionMimeType(fileName)) {
        return null;
      }
      return isSupportedChatAttachmentMimeType(mimeType) ? mimeType : null;
    }
  }
  if (fileName) {
    const imageMimeType = resolveImageExtensionMimeType(fileName);
    if (imageMimeType) {
      return imageMimeType;
    }
  }
  return isSupportedChatAttachmentFile({ name: fileName, type: "" })
    ? "application/octet-stream"
    : null;
}
