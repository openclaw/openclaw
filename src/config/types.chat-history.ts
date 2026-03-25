/**
 * Chat history ingest configuration.
 * Enables logging of channel messages to workspace knowledge files.
 */

export type ChatHistoryChannelId = "telegram" | "slack" | "discord" | "signal" | "whatsapp";

export type ChatHistoryConfig = {
  /**
   * Enable chat history logging.
   * When enabled, incoming messages are appended to knowledge files.
   */
  enabled?: boolean;

  /**
   * Per-channel enable/disable.
   * If a channel is not specified, it inherits from `enabled`.
   */
  channels?: Partial<Record<ChatHistoryChannelId, boolean>>;

  /**
   * Storage configuration.
   */
  storage?: ChatHistoryStorageConfig;

  /**
   * Message format configuration.
   */
  format?: ChatHistoryFormatConfig;
};

export type ChatHistoryStorageConfig = {
  /**
   * Base path relative to workspace.
   * @default "knowledge/chat-history"
   */
  path?: string;

  /**
   * Create separate files per group/channel.
   * Structure: {path}/{channel}/groups/{group_id}/{YYYY-MM}.md
   * @default true
   */
  splitByGroup?: boolean;

  /**
   * Create monthly files (YYYY-MM.md) vs single file.
   * @default true
   */
  splitByMonth?: boolean;

  /**
   * Also write to a combined "all messages" file per channel.
   * Useful for global search.
   * @default true
   */
  combinedFile?: boolean;
};

export type ChatHistoryFormatConfig = {
  /**
   * Include user ID in message line.
   * Format: (uid:123456789)
   * @default true
   */
  includeUserId?: boolean;

  /**
   * Include group/channel ID in message line.
   * Format: (gid:-1002258503151)
   * @default true
   */
  includeGroupId?: boolean;

  /**
   * Include human-readable group name.
   * Format: in **Group Name**
   * @default true
   */
  includeGroupName?: boolean;

  /**
   * Timezone for timestamps.
   * @default "UTC"
   */
  timezone?: string;

  /**
   * Include reply/thread context.
   * Format: [reply to username]
   * @default true
   */
  includeReplyContext?: boolean;
};
