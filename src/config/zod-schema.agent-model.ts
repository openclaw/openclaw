// Defines agent model selection schema fragments.
import { parseProviderModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { z } from "zod";

/** Decision providers require an explicit model; an empty value disables the role. */
export const DecisionModelSchema = z
  .string()
  .trim()
  .max(512)
  .refine(
    (value) => value === "" || parseProviderModelRef(value) !== null,
    "Expected provider/model, or an empty string to disable decision models.",
  );

/** Schema for agent model config accepting a string or fallback object. */
export const AgentModelSchema = z.union([
  z.string(),
  z
    .object({
      /** Primary model (provider/model). */
      primary: z.string().optional(),
      /** Per-agent model fallbacks (provider/model). */
      fallbacks: z.array(z.string()).optional(),
    })
    .strict(),
]);

/**
 * Pre-compaction memory-flush model selector. A bare string keeps the exact
 * override default; the object form must name a primary whenever fallbacks are
 * supplied, so a fallback-only selector cannot silently inherit the active
 * conversation model's fallback chain (and its unnamed paid models).
 */
export const MemoryFlushModelSchema = AgentModelSchema.superRefine((value, ctx) => {
  if (typeof value === "object" && value !== null) {
    const hasFallbacks = (value.fallbacks?.length ?? 0) > 0;
    const hasPrimary = (value.primary?.trim().length ?? 0) > 0;
    if (hasFallbacks && !hasPrimary) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "memoryFlush.model.fallbacks requires a primary model; use a bare string to keep the exact-override default.",
        path: ["fallbacks"],
      });
    }
  }
});

export const AgentToolModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      /** Per-tool model fallbacks (provider/model). */
      fallbacks: z.array(z.string()).optional(),
      /** Optional provider request timeout in milliseconds for capabilities that support it. */
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
