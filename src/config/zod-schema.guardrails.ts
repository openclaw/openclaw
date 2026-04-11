import { z } from "zod";

const GuardrailProviderConfigSchema = z
  .object({
    use: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const GuardrailsSchema = z
  .object({
    enabled: z.boolean().optional(),
    failClosed: z.boolean().optional(),
    provider: GuardrailProviderConfigSchema.optional(),
  })
  .strict()
  .refine((val) => !val.enabled || val.provider?.use, {
    message: "guardrails.provider.use is required when guardrails.enabled is true",
    path: ["provider"],
  })
  .optional();
