const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const CHAT_ATTACHMENT_ACCEPT = ["image/*", ".docx", DOCX_MIME, ".xlsx", XLSX_MIME].join(",");

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  return mimeType.startsWith("image/") || mimeType === DOCX_MIME || mimeType === XLSX_MIME;
}
