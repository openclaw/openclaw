import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      /** Provider-specific API parameters (e.g., cacheRetention, temperature). */
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);
