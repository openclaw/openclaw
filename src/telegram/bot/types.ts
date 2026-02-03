import type { Message, UserFromGetMe } from "@grammyjs/types";

/** App-specific stream mode for Telegram draft streaming. */
export type TelegramStreamMode = "off" | "partial" | "block";

/**
 * Telegram message with potential forward metadata fields.
 * Used for type-safe destructuring when stripping forward fields from batched messages.
 */
export type TelegramForwardedMessage = Message & {
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_sender_name?: unknown;
  forward_date?: unknown;
  forward_signature?: unknown;
};

/**
 * Base Telegram message type for synthetic/combined messages.
 * Alias for Message to clarify intent when building combined messages.
 */
export type TelegramMessage = Message;

/**
 * Minimal context projection from Grammy's Context class.
 * Decouples the message processing pipeline from Grammy's full Context,
 * and allows constructing synthetic contexts for debounced/combined messages.
 */
export type TelegramContext = {
  message: Message;
  me?: UserFromGetMe;
  getFile: () => Promise<{ file_path?: string }>;
};

/** Telegram sticker metadata for context enrichment and caching. */
export interface StickerMetadata {
  /** Emoji associated with the sticker. */
  emoji?: string;
  /** Name of the sticker set the sticker belongs to. */
  setName?: string;
  /** Telegram file_id for sending the sticker back. */
  fileId?: string;
  /** Stable file_unique_id for cache deduplication. */
  fileUniqueId?: string;
  /** Cached description from previous vision processing (skip re-processing if present). */
  cachedDescription?: string;
}
