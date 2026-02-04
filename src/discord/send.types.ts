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

/**
 * Discord button styles:
 * 1 = Primary (blurple)
 * 2 = Secondary (grey)
 * 3 = Success (green)
 * 4 = Danger (red)
 * 5 = Link (grey, navigates to URL)
 */
export type DiscordButtonStyle = 1 | 2 | 3 | 4 | 5;

export type DiscordButton = {
  /** Component type - always 2 for buttons */
  type: 2;
  /** Button style */
  style: DiscordButtonStyle;
  /** Text on the button (max 80 chars) */
  label: string;
  /** Custom identifier for non-link buttons (max 100 chars) */
  custom_id?: string;
  /** URL for link buttons (style 5) */
  url?: string;
  /** Whether button is disabled */
  disabled?: boolean;
  /** Emoji to display on button */
  emoji?: {
    id?: string;
    name?: string;
    animated?: boolean;
  };
};

export type DiscordActionRow = {
  /** Component type - always 1 for action rows */
  type: 1;
  /** Up to 5 buttons per row */
  components: DiscordButton[];
};

/** Array of action rows (up to 5 rows per message) */
export type DiscordMessageComponents = DiscordActionRow[];

export type DiscordSendResult = {
  messageId: string;
  channelId: string;
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
  name?: string;
  topic?: string;
  position?: number;
  parentId?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
};

export type DiscordChannelMove = {
  guildId: string;
  channelId: string;
  parentId?: string | null;
  position?: number;
};

export type DiscordChannelPermissionSet = {
  channelId: string;
  targetId: string;
  targetType: 0 | 1;
  allow?: string;
  deny?: string;
};
