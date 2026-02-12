import { z } from "zod";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import { GroupPolicySchema } from "./zod-schema.core.js";
import { SlackConfigSchema, TelegramConfigSchema } from "./zod-schema.providers-core.js";

export * from "./zod-schema.providers-core.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

export const ChannelsSchema = z
  .object({
    defaults: z
      .object({
        groupPolicy: GroupPolicySchema.optional(),
        heartbeat: ChannelHeartbeatVisibilitySchema,
      })
      .strict()
      .optional(),
    telegram: TelegramConfigSchema.optional(),
    slack: SlackConfigSchema.optional(),
  })
  .passthrough() // Allow extension channel configs
  .optional();
