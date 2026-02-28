import { z } from "zod";

export const HealthProbeModeSchema = z.union([z.literal("full"), z.literal("skip")]).optional();

export const ChannelHeartbeatVisibilitySchema = z
  .object({
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .strict()
  .optional();
