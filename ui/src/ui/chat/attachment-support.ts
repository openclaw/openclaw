// Authored by: cc (Claude Code) | 2026-03-20
// Matches backend DEFAULT_INPUT_IMAGE_MIMES + DEFAULT_INPUT_FILE_MIMES (src/media/input-files.ts).
// Keep in sync if backend adds new supported MIME types.
const SUPPORTED_FILE_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
  "application/json",
  "application/pdf",
]);

export const CHAT_ATTACHMENT_ACCEPT = ["image/*", ...SUPPORTED_FILE_MIMES].join(",");

export function isSupportedChatAttachmentMimeType(mimeType: string | null | undefined): boolean {
  if (typeof mimeType !== "string") {
    return false;
  }
  return mimeType.startsWith("image/") || SUPPORTED_FILE_MIMES.has(mimeType);
}
