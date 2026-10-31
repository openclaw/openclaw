/** Typed decision contract, version 1. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DecisionEntry =
  | string
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type DecisionQuestion =
  | {
      readonly type: "choice";
      readonly instructions?: DecisionEntry;
      readonly criteria: Readonly<Record<string, DecisionEntry>>;
    }
  | {
      readonly type: "score";
      readonly instructions?: DecisionEntry;
      readonly criteria: readonly DecisionEntry[];
    }
  | {
      readonly type: "boolean";
      readonly instructions?: DecisionEntry;
      readonly criteria?: {
        readonly true?: DecisionEntry;
        readonly false?: DecisionEntry;
      } | null;
    };

export type DecisionBatch = {
  readonly state: DecisionEntry;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
};

export type DecisionAnswer =
  | {
      readonly type: "choice";
      /** Provider-reported label; not required to be the rounded distribution's argmax. */
      readonly choice: string;
      /** Provider-reported estimates in [0, 1]; rounding may make their sum differ from one. */
      readonly probabilities: Readonly<Record<string, number>>;
      /** Provider-specific distribution metric, not correctness probability. */
      readonly confidence?: number;
    }
  | {
      readonly type: "score";
      /** Provider's fractional zero-based rubric estimate, bounded by its first and last positions. */
      readonly score: number;
      /** Index-aligned estimates in [0, 1]; may be rounded independently of the score. */
      readonly probabilities: readonly number[];
      readonly confidence?: number;
    }
  | {
      readonly type: "boolean";
      readonly probabilityTrue: number;
    };

export type DecisionBatchResult = {
  /** Resolved vendor model identity, not a host conversational-model record. */
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
  };
};

export type ProviderFailureReason =
  | "credentials-unavailable"
  | "authentication"
  | "rate-limited"
  | "transport"
  | "unsupported-input"
  | "invalid-response";

export type UnavailableReason =
  | ProviderFailureReason
  | "disabled"
  | "not-configured"
  | "retiring"
  | "overloaded"
  | "circuit-open"
  | "deadline";

export type ProviderDecisionOutcome =
  | { readonly status: "ok"; readonly result: DecisionBatchResult }
  | {
      readonly status: "unavailable";
      readonly reason: ProviderFailureReason;
      /** Validated and bounded by host; does not cause an automatic retry. */
      readonly retryAfterMs?: number;
    };

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
