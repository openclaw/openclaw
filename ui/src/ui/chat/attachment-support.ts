import {
  chatVideoAttachmentMimeTypeFromFileName,
  isKnownChatVideoAttachmentFileName,
  isSupportedChatVideoAttachmentFileName,
  isSupportedChatVideoAttachmentMimeType,
  isUnsupportedChatVideoAttachmentFileName,
  normalizeChatAttachmentMimeType,
} from "../../../../src/shared/chat-attachment-policy.ts";

export const CHAT_ATTACHMENT_ACCEPT =
  "image/*,audio/*,video/mp4,video/quicktime,video/webm,application/pdf,text/*," +
  ".csv,.json,.md,.txt,.zip,.m4v,.mov,.mp4,.webm,.doc,.docx,.xls,.xlsx,.ppt,.pptx";

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  const normalized = normalizeChatAttachmentMimeType(mimeType);
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith("video/")) {
    return isSupportedChatVideoAttachmentMimeType(normalized);
  }
  return true;
}

export function isSupportedChatAttachmentFile(file: Pick<File, "name" | "type">): boolean {
  const mimeType = normalizeChatAttachmentMimeType(file.type);
  if (isUnsupportedChatVideoAttachmentFileName(file.name)) {
    return false;
  }
  if (mimeType?.startsWith("video/")) {
    return (
      isSupportedChatVideoAttachmentMimeType(mimeType) ||
      isSupportedChatVideoAttachmentFileName(file.name)
    );
  }
  if (isKnownChatVideoAttachmentFileName(file.name)) {
    return isSupportedChatVideoAttachmentFileName(file.name);
  }
  return true;
}

export function resolveChatAttachmentFileMimeType(file: Pick<File, "name" | "type">): string {
  const mimeType = normalizeChatAttachmentMimeType(file.type);
  if (mimeType?.startsWith("video/") && !isSupportedChatVideoAttachmentMimeType(mimeType)) {
    return chatVideoAttachmentMimeTypeFromFileName(file.name) ?? mimeType;
  }
  return (
    mimeType ?? chatVideoAttachmentMimeTypeFromFileName(file.name) ?? "application/octet-stream"
  );
}
