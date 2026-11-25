export const MIN_CHAT_IMAGE_PREVIEW_WIDTH = 160;

export type ChatImagePreviewSize = { width: number; height: number };

export function fitChatImagePreview(
  size: ChatImagePreviewSize,
  bounds: ChatImagePreviewSize,
): ChatImagePreviewSize {
  const scale = Math.min(1, bounds.width / size.width, bounds.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

export function resolveChatImagePreviewSize(
  image: { width?: number; height?: number },
  decoded?: { width: number; height: number },
) {
  const sized =
    Number.isFinite(image.width) &&
    (image.width ?? 0) > 0 &&
    Number.isFinite(image.height) &&
    (image.height ?? 0) > 0;
  if (!sized && decoded) {
    return resolveChatImagePreviewSize(decoded);
  }
  const ratio = sized ? image.width! / image.height! : 3 / 2;
  const width = sized
    ? Math.min(Math.max(image.width!, MIN_CHAT_IMAGE_PREVIEW_WIDTH), 400, 360 * ratio)
    : 400;
  return { width, height: width / ratio };
}
