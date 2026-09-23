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
