import { z } from "zod";

const VisibleRepliesValueSchema = z.enum(["automatic", "message_tool"]);

const VisibleRepliesSchema = z
  .union([VisibleRepliesValueSchema, z.boolean()])
  .overwrite((value) => {
    if (value === true) {
      return "automatic";
    }
    if (value === false) {
      return "message_tool";
    }
    return value;
  });

export const MentionPatternsPolicySchema = z
  .object({
    mode: z.union([z.literal("allow"), z.literal("deny")]).optional(),
    allowIn: z.array(z.string()).optional(),
    denyIn: z.array(z.string()).optional(),
  })
  .strict();

export const GroupChatSchema = z
  .object({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    unmentionedInbound: z.enum(["user_request", "room_event"]).optional(),
    visibleReplies: VisibleRepliesSchema.optional(),
  })
  .strict()
  .optional();

export const DmConfigSchema = z
  .object({
    historyLimit: z.number().int().min(0).optional(),
  })
  .strict();

const QueueModeSchema = z.union([
  z.literal("steer"),
  z.literal("followup"),
  z.literal("collect"),
  z.literal("interrupt"),
]);
const QueueDropSchema = z.union([z.literal("old"), z.literal("new"), z.literal("summarize")]);
const QueueModeBySurfaceSchema = z
  .object({
    whatsapp: QueueModeSchema.optional(),
    telegram: QueueModeSchema.optional(),
    discord: QueueModeSchema.optional(),
    irc: QueueModeSchema.optional(),
    googlechat: QueueModeSchema.optional(),
    slack: QueueModeSchema.optional(),
    mattermost: QueueModeSchema.optional(),
    signal: QueueModeSchema.optional(),
    imessage: QueueModeSchema.optional(),
    msteams: QueueModeSchema.optional(),
    webchat: QueueModeSchema.optional(),
    matrix: QueueModeSchema.optional(),
  })
  .strict()
  .optional();
const DebounceMsBySurfaceSchema = z.record(z.string(), z.number().int().nonnegative()).optional();

export const QueueSchema = z
  .object({
    mode: QueueModeSchema.optional(),
    byChannel: QueueModeBySurfaceSchema,
    debounceMsByChannel: DebounceMsBySurfaceSchema,
    cap: z.number().int().positive().optional(),
    drop: QueueDropSchema.optional(),
  })
  .strict()
  .optional();

export const InboundDebounceSchema = z
  .object({
    debounceMs: z.number().int().nonnegative().optional(),
    byChannel: DebounceMsBySurfaceSchema,
  })
  .strict()
  .optional();

export const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);

export const ProviderCommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional(),
    nativeSkills: NativeCommandsSettingSchema.optional(),
  })
  .strict()
  .optional();

const ResponseUsageModeSchema = z.enum(["on", "off", "tokens", "full"]);

export const MessagesSchema = z
  .object({
    visibleReplies: VisibleRepliesSchema.optional(),
    responsePrefix: z.string().optional(),
    usageTemplate: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    responseUsage: z
      .union([ResponseUsageModeSchema, z.record(z.string(), ResponseUsageModeSchema)])
      .optional(),
    groupChat: GroupChatSchema,
    queue: QueueSchema,
    inbound: InboundDebounceSchema,
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    statusReactions: z.object({ enabled: z.boolean().optional() }).strict().optional(),
  })
  .strict()
  .optional();

export const BroadcastSchema = z
  .object({ strategy: z.enum(["parallel", "sequential"]).optional() })
  .catchall(z.array(z.string()))
  .optional();
