import { z } from "zod";

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);

export const AgentChatModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      userOverrideFallbackPolicy: z.enum(["strict", "resilient"]).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
