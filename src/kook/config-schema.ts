// KOOK Configuration Schema
import { z } from "zod";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing"]);
const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);
const ReplyToModeSchema = z.enum(["off", "first", "all"]);

const KookChannelConfigSchema = z
  .object({
    allow: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const KookGuildConfigSchema = z
  .object({
    slug: z.string().optional(),
    requireMention: z.boolean().optional(),
    users: z.array(z.union([z.string(), z.number()])).optional(),
    channels: z.record(z.string(), KookChannelConfigSchema.optional()).optional(),
  })
  .strict();

const KookDmConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    policy: DmPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const KookAccountConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
    dm: KookDmConfigSchema.optional(),
    groupPolicy: GroupPolicySchema.optional().default("disabled"),
    guilds: z.record(z.string(), KookGuildConfigSchema.optional()).optional(),
    historyLimit: z.number().optional(),
    mediaMaxMb: z.number().optional(),
    textChunkLimit: z.number().optional(),
    replyToMode: ReplyToModeSchema.optional(),
  })
  .strict();

// Kook Actions Configuration Schema
// Default: read-only actions enabled, write/modify/delete actions disabled
const KookActionsSchema = z
  .object({
    // User Queries (default: enabled)
    getMe: z.boolean().optional(),
    getUser: z.boolean().optional(),

    // Guild Queries (default: enabled)
    getGuildList: z.boolean().optional(),
    getGuild: z.boolean().optional(),
    getGuildUserCount: z.boolean().optional(),
    getGuildUsers: z.boolean().optional(),
    guildInfo: z.boolean().optional(), // Group for getGuild, getGuildUserCount, getGuildUsers

    // Channel Queries (default: enabled)
    getChannel: z.boolean().optional(),
    getChannelList: z.boolean().optional(),
    getChannelUserList: z.boolean().optional(),
    channelInfo: z.boolean().optional(), // Group for getChannel, getChannelUserList

    // Role Management (default: read-only enabled, write disabled)
    roleInfo: z.boolean().optional(),
    roles: z.boolean().optional(), // Group toggle for all role write operations

    // Channel Management (default: disabled)
    channels: z.boolean().optional(), // Group toggle for channel create/update/delete/move

    // Member Management (default: disabled)
    memberInfo: z.boolean().optional(), // For updateNickname
    moderation: z.boolean().optional(), // Group toggle for kick/mute operations

    // Emoji Management (default: read-only enabled, write disabled)
    emojiList: z.boolean().optional(),
    emojiUploads: z.boolean().optional(), // Group toggle for emoji create/update/delete

    // Voice Management (default: disabled)
    voiceStatus: z.boolean().optional(), // For voice channel operations
  })
  .strict()
  .optional();

export const KookConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    token: z.string().optional(),
    tokenFile: z.string().optional(),
    dm: KookDmConfigSchema.optional(),
    groupPolicy: GroupPolicySchema.optional().default("disabled"),
    guilds: z.record(z.string(), KookGuildConfigSchema.optional()).optional(),
    historyLimit: z.number().optional(),
    mediaMaxMb: z.number().optional(),
    textChunkLimit: z.number().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    accounts: z.record(z.string(), KookAccountConfigSchema.optional()).optional(),
    actions: KookActionsSchema,
  })
  .strict();

export type KookConfigSchemaType = z.infer<typeof KookConfigSchema>;
export type KookAccountConfigSchemaType = z.infer<typeof KookAccountConfigSchema>;
