// Defines agent model selection schema fragments.
import { z } from "zod";

/** Schema for agent model config accepting a string or fallback object. */
export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).nullable().optional(),
    })
    .strict(),
]);

export const AgentToolModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).nullable().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
