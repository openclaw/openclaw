import { z } from "zod";

export const AotuiPromptRoleSchema = z
  .union([z.literal("user"), z.literal("assistant")])
  .optional();

export const AotuiAppRegistryEntrySchema = z
  .object({
    source: z.string(),
    version: z.string().optional(),
    enabled: z.boolean().optional(),
    workerScript: z.string().optional(),
    description: z.string().optional(),
    whatItIs: z.string().optional(),
    whenToUse: z.string().optional(),
    promptRole: AotuiPromptRoleSchema,
  })
  .strict();

export const AotuiAgentSelectionSchema = z
  .object({
    apps: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const AotuiConfigSchema = z
  .object({
    apps: z.record(z.string(), AotuiAppRegistryEntrySchema).optional(),
  })
  .strict()
  .optional();
