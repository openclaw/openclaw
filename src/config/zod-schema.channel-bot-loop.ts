import { z } from "zod";

export const ChannelBotLoopProtectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxEventsPerWindow: z.number().int().positive().optional(),
    windowSeconds: z.number().int().positive().optional(),
    cooldownSeconds: z.number().int().positive().optional(),
    /** Bot events allowed per conversation in a rolling 10-minute window (3+ active bots) before suppression. */
    maxConversationBotEvents: z.number().int().positive().max(500).optional(),
  })
  .strict();
