// Defines session-related Zod schema fragments for config parsing.
import { z } from "zod";
import { ElevatedAllowFromSchema } from "./zod-schema.agent-runtime.js";
import {
  GroupChatSchema,
  InboundDebounceSchema,
  NativeCommandsSettingSchema,
  QueueSchema,
  VisibleRepliesSchema,
} from "./zod-schema.core.js";

export { SessionSchema } from "./zod-schema.session-config.js";

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
    statusReactions: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export const CommandsSchema = z
  .object({
    native: NativeCommandsSettingSchema.optional().default("auto"),
    nativeSkills: NativeCommandsSettingSchema.optional().default("auto"),
    text: z.boolean().optional(),
    bash: z.boolean().optional(),
    bashForegroundMs: z.number().int().min(0).max(30_000).optional(),
    config: z.boolean().optional(),
    mcp: z.boolean().optional(),
    plugins: z.boolean().optional(),
    debug: z.boolean().optional(),
    restart: z.boolean().optional().default(true),
    ownerAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    allowFrom: ElevatedAllowFromSchema.optional(),
  })
  .strict()
  .optional()
  .default(
    () =>
      ({
        native: "auto",
        nativeSkills: "auto",
        restart: true,
      }) as const,
  );
