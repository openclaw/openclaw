import type { ProviderFailureReason } from "./provider-outcomes.js";
import type { DecisionBatchResultV2 } from "./types-v2.js";
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

export type DecisionOutcomeV2 =
  | {
      readonly status: "ok";
      readonly result: DecisionBatchResultV2;
      readonly provenance: Extract<DecisionOutcome, { status: "ok" }>["provenance"];
    }
  | Extract<DecisionOutcome, { status: "unavailable" }>;
