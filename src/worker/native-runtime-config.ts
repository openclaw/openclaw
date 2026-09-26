import path from "node:path";
import { MODEL_CATALOG_THINKING_LEVELS } from "@openclaw/model-catalog-core/model-catalog-types";
import { z } from "zod";
const ThinkingSchema = z.enum(MODEL_CATALOG_THINKING_LEVELS);
export const NativeRuntimeIdentifier = z.string().trim().min(1).max(256);
const provider = NativeRuntimeIdentifier.refine(
  (value) => !value.includes("/"),
  "Provider must not contain /",
);
const baseUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[{}]/.test(value)
    );
  }, "Expected an explicit HTTP(S) endpoint without credentials, query, or placeholders");

/** Trusted local startup configuration, never a turn-wire configuration surface. */
export const NativeRuntimeConfigSchema = z.strictObject({
  models: z
    .array(
      z.strictObject({
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
        apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
        headers: z.record(z.string(), z.string()).optional(),
        sensitiveHeaderNames: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
  workspaces: z
    .array(
      z.strictObject({
        id: NativeRuntimeIdentifier,
        path: z
          .string()
          .min(1)
          .refine((value) => path.isAbsolute(value), "Workspace grants require absolute paths"),
        sessionId: NativeRuntimeIdentifier.optional(),
        scope: z.enum(["exact", "subdirectories"]).optional(),
        models: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
});
export type NativeRuntimeConfig = z.infer<typeof NativeRuntimeConfigSchema>;
