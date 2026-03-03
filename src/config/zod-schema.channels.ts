import { z } from "zod";

export const ErrorPolicySchema = z.enum(["reply", "silent", "react-only"]).optional();

export const ChannelHeartbeatVisibilitySchema = z
  .object({
    showOk: z.boolean().optional(),
    showAlerts: z.boolean().optional(),
    useIndicator: z.boolean().optional(),
  })
  .strict()
  .optional();
