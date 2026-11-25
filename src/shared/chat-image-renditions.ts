const CHAT_IMAGE_RENDITION_WIDTHS = [480, 960, 1920] as const;

export type ChatImageRenditionWidth = (typeof CHAT_IMAGE_RENDITION_WIDTHS)[number];

export const DEFAULT_CHAT_IMAGE_RENDITION_WIDTH: ChatImageRenditionWidth = 960;

export const CHAT_IMAGE_RENDITION_MAX_BYTES = {
  480: 96 * 1024,
  960: 256 * 1024,
  1920: 512 * 1024,
} as const satisfies Record<ChatImageRenditionWidth, number>;

/** Unrecognized query values share the default cache entry, never create arbitrary sizes. */
export function normalizeChatImageRenditionWidth(value: unknown): ChatImageRenditionWidth {
  if (value === 480 || value === "480") {
    return 480;
  }
  if (value === 1920 || value === "1920") {
    return 1920;
  }
  return DEFAULT_CHAT_IMAGE_RENDITION_WIDTH;
}
