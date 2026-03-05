import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      fallbackStrategy: z.enum(["ordered", "cost", "round-robin"]).optional(),
    })
    .strict(),
]);
