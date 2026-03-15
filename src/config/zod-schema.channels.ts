import { z } from "zod";

export const ChannelHeartbeatVisibilitySchema = z
  .object({
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .strict()
  .optional();

export const ChannelHealthMonitorSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict()
  .optional();
