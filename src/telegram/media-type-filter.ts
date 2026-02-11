import type { Message } from "@grammyjs/types";

/** Media types silently skipped in group chats when ignoreMediaTypes is not explicitly configured. */
export const GROUP_DEFAULT_IGNORE_MEDIA_TYPES: readonly string[] = ["video_note", "video"];

/** Resolve the Telegram media type string from a message, or null if no media. */
export function resolveTelegramMediaType(msg: Message): string | null {
  if (msg.video_note) {
    return "video_note";
  }
  if (msg.voice) {
    return "voice";
  }
  if (msg.audio) {
    return "audio";
  }
  if (msg.video) {
    return "video";
  }
  if (msg.document) {
    return "document";
  }
  if (msg.photo) {
    return "photo";
  }
  if (msg.sticker) {
    return "sticker";
  }
  return null;
}

/**
 * Return the effective ignore list for a given context.
 * Uses explicit config when set; otherwise falls back to group defaults in group chats.
 */
export function resolveIgnoreMediaTypes(
  configuredTypes: readonly string[] | undefined,
  isGroup: boolean,
): readonly string[] {
  return configuredTypes ?? (isGroup ? GROUP_DEFAULT_IGNORE_MEDIA_TYPES : []);
}
