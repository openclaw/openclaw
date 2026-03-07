import type { RequestClient } from "@buape/carbon";
import type { RetryConfig } from "../infra/retry.js";

export class DiscordSendError extends Error {
  kind?: "missing-permissions" | "dm-blocked";
  channelId?: string;
  missingPermissions?: string[];

  constructor(message: string, opts?: Partial<DiscordSendError>) {
    super(message);
    this.name = "DiscordSendError";
    if (opts) {
      Object.assign(this, opts);
    }
  }

  override toString() {
    return this.message;
  }
}

export const DISCORD_MAX_EMOJI_BYTES = 256 * 1024;
export const DISCORD_MAX_STICKER_BYTES = 512 * 1024;

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
  /** User or role ID to set permissions for. */
};

export type DiscordReactOpts = {
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  verbose?: boolean;
  retry?: RetryConfig;
};

export type DiscordReactionUser = {
  id: string;
  username?: string;
  tag?: string;
};

export type DiscordReactionSummary = {
  emoji: { id?: string | null; name?: string | null; raw: string };
  count: number;
  users: DiscordReactionUser[];
};

export type DiscordPermissionsSummary = {
  channelId: string;
  /** User or role ID to set permissions for. */
  guildId?: string;
  permissions: string[];
  raw: string;
  isDm: boolean;
  channelType?: number;
};

export type DiscordMessageQuery = {
  limit?: number;
  before?: string;
  after?: string;
  around?: string;
};

export type DiscordMessageEdit = {
  content?: string;
};

export type DiscordThreadCreate = {
  messageId?: string;
  name: string;
  autoArchiveMinutes?: number;
  content?: string;
  /** Discord thread type (default: PublicThread for standalone threads). */
  type?: number;
};

export type DiscordThreadList = {
  guildId: string;
  channelId?: string;
  includeArchived?: boolean;
  before?: string;
  limit?: number;
};

export type DiscordSearchQuery = {
  guildId: string;
  content: string;
  channelIds?: string[];
  authorIds?: string[];
  limit?: number;
};

export type DiscordRoleChange = {
  guildId: string;
  userId: string;
  roleId: string;
};

export type DiscordModerationTarget = {
  guildId: string;
  userId: string;
  reason?: string;
};

export type DiscordTimeoutTarget = DiscordModerationTarget & {
  until?: string;
  durationMinutes?: number;
};

export type DiscordEmojiUpload = {
  guildId: string;
  name: string;
  mediaUrl: string;
  roleIds?: string[];
};

export type DiscordStickerUpload = {
  guildId: string;
  name: string;
  description: string;
  tags: string;
  mediaUrl: string;
};

export type DiscordChannelCreate = {
  guildId: string;
  name: string;
  type?: number;
  parentId?: string;
  topic?: string;
  position?: number;
  nsfw?: boolean;
};

export type DiscordChannelEdit = {
  channelId: string;
  /** User or role ID to set permissions for. */
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  archived?: boolean;
  locked?: boolean;
  autoArchiveDuration?: number;
};

export type DiscordChannelMove = {
  guildId: string;
  channelId: string;
  /** User or role ID to set permissions for. */
  parentId?: string | null;
  position?: number;
};

export type DiscordChannelPermissionSet = {
  /** Channel to modify. */
  channelId: string;
  /** User or role ID to set permissions for. */
  targetId: string;
  /** Target type: 0 = role, 1 = member (user). */
  targetType: 0 | 1;
  /** Allowed permissions as comma-separated names (e.g., "ViewChannel,SendMessages") or bitmask string. */
  allow?: string;
  /** Denied permissions as comma-separated names (e.g., "ViewChannel") or bitmask string. */
  deny?: string;
};
