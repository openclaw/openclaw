import { z } from "zod";

export const AgentAppPromptRoleSchema = z
  .union([z.literal("user"), z.literal("assistant")])
  .optional();

export const AgentAppRegistryEntrySchema = z
  .object({
    source: z.string(),
    version: z.string().optional(),
    enabled: z.boolean().optional(),
    workerScript: z.string().optional(),
    description: z.string().optional(),
    whatItIs: z.string().optional(),
    whenToUse: z.string().optional(),
    promptRole: AgentAppPromptRoleSchema,
  })
  .strict();

export const AgentAppsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    registry: z.record(z.string(), AgentAppRegistryEntrySchema).optional(),
  })
  .strict()
  .optional();
