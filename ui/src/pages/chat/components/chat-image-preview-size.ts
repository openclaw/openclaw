export const MIN_CHAT_IMAGE_PREVIEW_WIDTH = 160;

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
