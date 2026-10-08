import { MODEL_CATALOG_THINKING_LEVELS } from "@openclaw/model-catalog-core/model-catalog-types";
import { z } from "zod";
import { isNativeRuntimeEndpoint } from "./native-runtime-transport.js";
const ThinkingSchema = z.enum(MODEL_CATALOG_THINKING_LEVELS);
export const NativeRuntimeIdentifier = z.string().trim().min(1).max(256);
const provider = NativeRuntimeIdentifier.refine(
  (value) => !value.includes("/"),
  "Provider must not contain /",
);
const baseUrl = z
  .string()
  .url()
  .refine(
    isNativeRuntimeEndpoint,
    "Expected HTTPS (or literal loopback HTTP) without credentials, query, or placeholders",
  );

/** Trusted local startup configuration, never a turn-wire configuration surface. */
export const NativeRuntimeModelSchema = z.strictObject({
  provider,
  id: NativeRuntimeIdentifier,
  api: NativeRuntimeIdentifier,
  baseUrl,
  name: NativeRuntimeIdentifier.optional(),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  reasoning: z.boolean().optional(),
  thinkingLevelMap: z.partialRecord(ThinkingSchema, z.string().nullable()).optional(),
  cost: z.strictObject({
    input: z.number().finite().nonnegative(),
    output: z.number().finite().nonnegative(),
    cacheRead: z.number().finite().nonnegative(),
    cacheWrite: z.number().finite().nonnegative(),
  }),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

/** Canonical node models and exact workspace projected into one trusted worker child. */
export const NativeRuntimeConfigSchema = z.strictObject({
  models: z
    .array(NativeRuntimeModelSchema)
    .min(1)
    .superRefine((models, ctx) => {
      const refs = new Set<string>();
      models.forEach((model, index) => {
        const ref = `${model.provider}/${model.id}`;
        if (refs.has(ref)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: "Duplicate native runtime model",
          });
        }
        refs.add(ref);
      });
    }),
  workspace: z.string().trim().min(1),
});
export type NativeRuntimeConfig = z.infer<typeof NativeRuntimeConfigSchema>;
export type NativeRuntimeModel = z.infer<typeof NativeRuntimeModelSchema>;
