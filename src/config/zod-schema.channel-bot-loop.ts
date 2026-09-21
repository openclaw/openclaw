import { z } from "zod";

export const ChannelBotLoopProtectionSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxEventsPerWindow: z.number().int().positive().optional(),
    windowSeconds: z.number().int().positive().optional(),
    cooldownSeconds: z.number().int().positive().optional(),
  })
  .strict();
