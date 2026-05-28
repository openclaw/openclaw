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

/**
 * Per-conversation system prompt overlay map shared by every channel config
 * schema. Keys are the exact conversation ids as seen at runtime
 * (`currentChannelId`); values are prompt file paths (absolute, `~`-relative,
 * or workspace-relative).
 */
export const ChannelSystemPromptByChannelSchema = z.record(z.string(), z.string()).optional();
