import { z } from "zod";

/** Optional heartbeat visibility controls shared by channel schemas. */
export const ChannelHeartbeatVisibilitySchema = z
  .strictObject({
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .optional();

export const ChannelHealthMonitorSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
  })
  .optional();
