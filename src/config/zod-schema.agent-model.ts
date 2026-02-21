import { z } from "zod";
import { parseDurationMs } from "../cli/parse-duration.js";

export const AgentModelObjectSchema = z
  .object({
    primary: z.string().optional(),
    fallbacks: z.array(z.string()).optional(),
    primaryRecoveryProbeEvery: z.string().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (!val.primaryRecoveryProbeEvery) {
      return;
    }
    try {
      parseDurationMs(val.primaryRecoveryProbeEvery, { defaultUnit: "m" });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["primaryRecoveryProbeEvery"],
        message: "invalid duration (use ms, s, m, h)",
      });
    }
  });

export const AgentModelSchema = z.union([z.string(), AgentModelObjectSchema]);
