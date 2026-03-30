export const CHAT_ATTACHMENT_ACCEPT = "image/*";

export function isSupportedChatAttachmentMimeType(
	mimeType: string | null | undefined,
): boolean {
	return typeof mimeType === "string" && mimeType.startsWith("image/");
}
