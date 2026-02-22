/**
 * Zod schema for thinking router configuration.
 */

import { z } from "zod";

const ThinkLevelSchema = z.union([
  z.literal("off"),
  z.literal("minimal"),
  z.literal("low"),
  z.literal("medium"),
  z.literal("high"),
  z.literal("xhigh"),
]);

const ThinkingRouterRuleMatchSchema = z
  .object({
    /** Keywords that trigger this rule (case-insensitive). */
    keywords: z.array(z.string()).optional(),
    /** Minimum message length in characters. */
    minLength: z.number().int().positive().optional(),
    /** Maximum message length in characters. */
    maxLength: z.number().int().positive().optional(),
    /** Message contains code blocks. */
    hasCode: z.boolean().optional(),
    /** Session type filter. */
    sessionType: z.union([z.literal("main"), z.literal("subagent"), z.literal("cron")]).optional(),
    /** Regex pattern to match (string form). */
    pattern: z.string().optional(),
  })
  .strict();

const ThinkingRouterRuleSchema = z
  .object({
    /** Match conditions for this rule. */
    match: ThinkingRouterRuleMatchSchema,
    /** Thinking level to apply when rule matches. */
    thinking: ThinkLevelSchema,
    /** Higher priority rules are checked first (default: 0). */
    priority: z.number().int().optional(),
  })
  .strict();

export const ThinkingRouterSchema = z
  .object({
    /** Enable dynamic thinking routing. */
    enabled: z.boolean().optional(),
    /** Default thinking level when no rules match. */
    default: ThinkLevelSchema,
    /** Routing rules (checked in priority order). */
    rules: z.array(ThinkingRouterRuleSchema),
  })
  .strict()
  .optional();

export type ThinkingRouterConfig = z.infer<typeof ThinkingRouterSchema>;
