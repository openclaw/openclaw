import type { ProviderFailureReason } from "./provider-outcomes.js";
import type { DecisionBatchResult } from "./types.js";

export type UnavailableReason =
  | ProviderFailureReason
  | "disabled"
  | "not-configured"
  | "retiring"
  | "overloaded"
  | "circuit-open"
  | "deadline";

export type DecisionOutcome =
  | {
      readonly status: "ok";
      readonly result: DecisionBatchResult;
      readonly provenance: {
        readonly providerId: string;
        readonly rubricVersion: string;
        /** Host-owned opaque identity; no secret values or SecretRef IDs. */
        readonly runtimeGeneration: string;
      };
    }
  | { readonly status: "unavailable"; readonly reason: UnavailableReason };
