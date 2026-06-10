import { z } from "zod";

export const llmOpsSchema = z
  .object({
    provider: z.enum(["local", "langfuse"]).optional().default("local"),
    langfuse: z
      .object({
        publicKey: z.string(),
        secretKey: z.string(),
        baseUrl: z.string().url().optional(),
      })
      .optional(),
    prompts: z
      .object({
        enabled: z.boolean().optional().default(false),
        cacheTtlMs: z.number().optional().default(60000),
        failSoft: z.boolean().optional().default(true),
      })
      .optional(),
    tracing: z
      .object({
        enabled: z.boolean().optional().default(false),
        sampleRate: z.number().min(0).max(1).optional().default(1.0),
      })
      .optional(),
    evaluation: z
      .object({
        enabled: z.boolean().optional().default(false),
        metrics: z.array(z.string()).optional(),
      })
      .optional(),
  })
  .optional();
