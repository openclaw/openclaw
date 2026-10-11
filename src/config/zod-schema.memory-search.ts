import { z } from "zod";
import { SecretInputSchema } from "./zod-schema.secret-input.js";
import { sensitive } from "./zod-schema.sensitive.js";

export const MemorySearchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    rememberAcrossConversations: z.boolean().optional(),
    sources: z.array(z.union([z.literal("memory"), z.literal("sessions")])).optional(),
    extraPaths: z
      .array(
        z.union([z.string(), z.strictObject({ path: z.string(), pattern: z.string().optional() })]),
      )
      .optional(),
    multimodal: z
      .strictObject({
        enabled: z.boolean().optional(),
        modalities: z
          .array(z.union([z.literal("image"), z.literal("audio"), z.literal("all")]))
          .optional(),
        maxFileBytes: z.number().int().positive().optional(),
      })
      .optional(),
    experimental: z.strictObject({ sessionMemory: z.boolean().optional() }).optional(),
    provider: z.string().optional(),
    remote: z
      .strictObject({
        baseUrl: z.string().optional(),
        apiKey: SecretInputSchema.optional().register(sensitive),
        headers: z.record(z.string(), z.string()).optional(),
        batch: z
          .strictObject({
            enabled: z.boolean().optional(),
          })
          .optional(),
      })
      .optional(),
    fallback: z.string().optional(),
    model: z.string().optional(),
    inputType: z.string().min(1).optional(),
    queryInputType: z.string().min(1).optional(),
    documentInputType: z.string().min(1).optional(),
    outputDimensionality: z.number().int().positive().optional(),
    local: z
      .strictObject({
        modelPath: z.string().optional(),
      })
      .optional(),
    store: z
      .strictObject({
        fts: z
          .strictObject({
            tokenizer: z.union([z.literal("unicode61"), z.literal("trigram")]).optional(),
          })
          .optional(),
        vector: z
          .strictObject({
            enabled: z.boolean().optional(),
            extensionPath: z.string().optional(),
          })
          .optional(),
      })
      .optional(),
    query: z
      .strictObject({
        maxResults: z.number().int().positive().optional(),
        minScore: z.number().min(0).max(1).optional(),
      })
      .optional(),
    cache: z
      .strictObject({
        enabled: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export type MemorySearchConfigInput = NonNullable<z.input<typeof MemorySearchSchema>>;
