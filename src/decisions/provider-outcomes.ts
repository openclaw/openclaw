import type { DecisionBatchResult } from "./types.js";

export type ProviderFailureReason =
  | "credentials-unavailable"
  | "authentication"
  | "rate-limited"
  | "transport"
  | "unsupported-input"
  | "invalid-response";

export type ProviderDecisionOutcome =
  | { readonly status: "ok"; readonly result: DecisionBatchResult }
  | {
      readonly status: "unavailable";
      readonly reason: ProviderFailureReason;
      /** Validated and bounded by host; does not cause an automatic retry. */
      readonly retryAfterMs?: number;
    };
