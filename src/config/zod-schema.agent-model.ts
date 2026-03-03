import { z } from "zod";

const AdaptiveRoutingValidationSchema = z
  .object({
    mode: z.enum(["heuristic", "llm"]).optional(),
    minScore: z.number().min(0).max(1).optional(),
    validatorModel: z.string().optional(),
    maxToolOutputChars: z.number().int().positive().optional(),
    maxAssistantChars: z.number().int().positive().optional(),
    redactSecrets: z.boolean().optional(),
  })
  .strict();

const AdaptiveRoutingSchema = z
  .object({
    enabled: z.boolean().optional(),
    localFirstModel: z.string().optional(),
    cloudEscalationModel: z.string().optional(),
    maxEscalations: z.number().int().min(0).max(1).optional(),
    bypassOnExplicitOverride: z.boolean().optional(),
    includeLocalAttemptSummary: z.boolean().optional(),
    localTrialReadOnly: z.boolean().optional(),
    validation: AdaptiveRoutingValidationSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.enabled) {
      return;
    }
    if (!val.localFirstModel?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["localFirstModel"],
        message: "localFirstModel is required when adaptiveRouting.enabled is true",
      });
    }
    if (!val.cloudEscalationModel?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["cloudEscalationModel"],
        message: "cloudEscalationModel is required when adaptiveRouting.enabled is true",
      });
    }
    if (val.validation?.mode === "llm" && !val.validation.validatorModel?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validation", "validatorModel"],
        message: "validation.validatorModel is required when validation.mode is 'llm'",
      });
    }
  });

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      adaptiveRouting: AdaptiveRoutingSchema.optional(),
    })
    .strict(),
]);
