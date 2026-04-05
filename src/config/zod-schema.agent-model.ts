import { z } from "zod";

export const AgentModelObjectSchema = z
  .object({
    primary: z.string().optional(),
    fallbacks: z.array(z.string()).optional(),
  })
  .strict();

export const AgentModelSchema = z.union([z.string(), AgentModelObjectSchema]);
