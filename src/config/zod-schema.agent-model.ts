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
  z.strictObject({
    /** Primary model (provider/model). */
    primary: z.string().optional(),
    /** Per-agent model fallbacks (provider/model). */
    fallbacks: z.array(z.string()).optional(),
  }),
]);

/** Opt-in route circuit breaker for the model fallback chain. */
const ModelCircuitBreakerSchema = z.strictObject({
  /**
   * Bypass a route that keeps failing with transient provider errors, but only
   * while another configured route can still reach transport. Off by default.
   */
  enabled: z.boolean().optional(),
});

/**
 * `agents.defaults.model` additionally accepts the route circuit breaker
 * switch. The circuit is process-global (keyed by agent dir, provider, and
 * model), so it is only honored here rather than on every model chain.
 */
export const AgentDefaultModelSchema = z.union([
  z.string(),
  z.strictObject({
    /** Primary model (provider/model). */
    primary: z.string().optional(),
    /** Default model fallbacks (provider/model). */
    fallbacks: z.array(z.string()).optional(),
    /** Opt-in route circuit breaker for the fallback chain. */
    circuitBreaker: ModelCircuitBreakerSchema.optional(),
  }),
]);

export const AgentToolModelSchema = z.union([
  z.string(),
  z.strictObject({
    primary: z.string().optional(),
    /** Per-tool model fallbacks (provider/model). */
    fallbacks: z.array(z.string()).optional(),
    /** Optional provider request timeout in milliseconds for capabilities that support it. */
    timeoutMs: z.number().int().positive().optional(),
  }),
]);
