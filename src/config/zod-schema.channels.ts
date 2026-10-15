import { z } from "zod";

export const ChannelHealthMonitorSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
  })
  .optional();
