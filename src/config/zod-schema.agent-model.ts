import { z } from "zod";

export const AgentModelByChatTypeSchema = z
  .object({
    direct: z.string().optional(),
    group: z.string().optional(),
    channel: z.string().optional(),
  })
  .strict();

export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      byChatType: AgentModelByChatTypeSchema.optional(),
    })
    .strict(),
]);
