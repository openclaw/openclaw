const CHAT_VIDEO_ATTACHMENT_MIME_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
const CHAT_VIDEO_ATTACHMENT_EXTENSIONS = new Set(["m4v", "mov", "mp4", "webm"]);
const CHAT_VIDEO_ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  m4v: "video/mp4",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
};
const UNSUPPORTED_CHAT_VIDEO_ATTACHMENT_EXTENSIONS = new Set([
  "avi",
  "flv",
  "mkv",
  "mpeg",
  "mpg",
  "wmv",
]);

export const SUPPORTED_CHAT_VIDEO_ATTACHMENT_FORMAT_LABEL = "MP4, M4V, MOV, or WebM";

export function normalizeChatAttachmentMimeType(
  mimeType: string | null | undefined,
): string | undefined {
  if (typeof mimeType !== "string") {
    return undefined;
  }
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalized || undefined;
}

export function chatAttachmentFileExtension(
  fileName: string | null | undefined,
): string | undefined {
  if (typeof fileName !== "string") {
    return undefined;
  }
  const match = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(fileName.trim());
  return match?.[1]?.toLowerCase();
}

export function isSupportedChatVideoAttachmentMimeType(
  mimeType: string | null | undefined,
): boolean {
  const normalized = normalizeChatAttachmentMimeType(mimeType);
  return Boolean(normalized && CHAT_VIDEO_ATTACHMENT_MIME_TYPES.has(normalized));
}

export function isSupportedChatVideoAttachmentFileName(
  fileName: string | null | undefined,
): boolean {
  const ext = chatAttachmentFileExtension(fileName);
  return Boolean(ext && CHAT_VIDEO_ATTACHMENT_EXTENSIONS.has(ext));
}

export function chatVideoAttachmentMimeTypeFromFileName(
  fileName: string | null | undefined,
): string | undefined {
  const ext = chatAttachmentFileExtension(fileName);
  return ext ? CHAT_VIDEO_ATTACHMENT_MIME_BY_EXTENSION[ext] : undefined;
}

export function isUnsupportedChatVideoAttachmentFileName(
  fileName: string | null | undefined,
): boolean {
  const ext = chatAttachmentFileExtension(fileName);
  return Boolean(ext && UNSUPPORTED_CHAT_VIDEO_ATTACHMENT_EXTENSIONS.has(ext));
}

export function isKnownChatVideoAttachmentFileName(fileName: string | null | undefined): boolean {
  return (
    isSupportedChatVideoAttachmentFileName(fileName) ||
    isUnsupportedChatVideoAttachmentFileName(fileName)
  );
}
