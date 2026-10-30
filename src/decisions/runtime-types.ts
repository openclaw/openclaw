import type { DecisionProviderContextV2 } from "./provider-context.js";
import type { DecisionBatchV2, DecisionOutcomeV2 } from "./types-v2.js";
import type { DecisionBatch, DecisionOutcome } from "./types.js";

/**
 * Supplied by the host, bound to its consumer's live authority/lifecycle.
 * Not a constructible global service or an unbound registry lookup.
 */
export interface DecisionRuntimeV1 {
  evaluate(
    batch: DecisionBatch,
    options: {
      /** Omit for the default role; agent-owned work supplies its owner agent. */
      readonly agentId?: string;
      readonly purpose: string;
      /** Defaults to requested; optional work leaves capacity for requested evaluations. */
      readonly priority?: "requested" | "optional";
      readonly rubricVersion: string;
      /** Budget includes preparation; provider cleanup remains physically awaited. */
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<DecisionOutcome>;
}

/** Execution options add only provider-declared reasoning to the established caller contract. */
export type DecisionEvaluateOptionsV2 = Parameters<DecisionRuntimeV1["evaluate"]>[1] & {
  readonly reasoning?: DecisionProviderContextV2["reasoning"];
};

export interface DecisionRuntimeV2 extends DecisionRuntimeV1 {
  evaluateV2(
    batch: DecisionBatchV2,
    options: DecisionEvaluateOptionsV2,
  ): Promise<DecisionOutcomeV2>;
}

// Caller cancellation, closed host authority, and programmer/contract errors
// reject rather than becoming an unavailable result. The host recognizes its
// own deadline/retirement abort separately while preserving caller cancellation.
