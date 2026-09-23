import { z } from "zod";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const MemorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    rememberAcrossConversations: z.boolean().optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    extraPaths: z
      .array(
        z.union([
          z.string(),
          z.object({ path: z.string(), pattern: z.string().optional() }).strict(),
        ]),
      )
      .optional(),
    multimodal: z
      .object({
        enabled: z.boolean().optional(),
        modalities: z
          .array(z.union([z.literal("image"), z.literal("audio"), z.literal("all")]))
          .optional(),
        maxFileBytes: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    experimental: z.object({ sessionMemory: z.boolean().optional() }).strict().optional(),
    provider: z.string().optional(),
    remote: z
      .object({
        baseUrl: z.string().optional(),
        apiKey: SecretInputSchema.optional().register(sensitive),
        headers: z.record(z.string(), z.string()).optional(),
        batch: z
          .object({
            enabled: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    fallback: z.string().optional(),
    model: z.string().optional(),
    inputType: z.string().min(1).optional(),
    queryInputType: z.string().min(1).optional(),
    documentInputType: z.string().min(1).optional(),
    outputDimensionality: z.number().int().positive().optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
      })
      .strict()
      .optional(),
    store: z
      .object({
        fts: z
          .object({
            tokenizer: z.union([z.literal("unicode61"), z.literal("trigram")]).optional(),
          })
          .strict()
          .optional(),
        vector: z
          .object({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    query: z
      .object({
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

export type MemorySearchConfigInput = NonNullable<z.input<typeof MemorySearchSchema>>;
