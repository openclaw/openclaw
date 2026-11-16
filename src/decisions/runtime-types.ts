import type { DecisionEvaluateOptions, DecisionEvaluateOptionsV2 } from "./execution-types.js";
import type { DecisionOutcome, DecisionOutcomeV2 } from "./host-outcomes.js";
import type { DecisionBatchV2 } from "./types-v2.js";
import type { DecisionBatch } from "./types.js";

/**
 * Supplied by the host, bound to its consumer's live authority/lifecycle.
 * Not a constructible global service or an unbound registry lookup.
 */
export interface DecisionRuntimeV1 {
  evaluate(batch: DecisionBatch, options: DecisionEvaluateOptions): Promise<DecisionOutcome>;
}

export interface DecisionRuntimeV2 extends DecisionRuntimeV1 {
  evaluateV2(
    batch: DecisionBatchV2,
    options: DecisionEvaluateOptionsV2,
  ): Promise<DecisionOutcomeV2>;
}

// Caller cancellation, closed host authority, and programmer/contract errors
// reject rather than becoming an unavailable result. The host recognizes its
// own deadline/retirement abort separately while preserving caller cancellation.
