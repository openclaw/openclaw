import type { DecisionTaskId } from "./task-ids.js";

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

export interface DecisionProviderV1 {
  readonly id: string;
  readonly contractVersion: 1;
  /** Prepared local credential availability only; must not perform I/O. */
  isReady?(): boolean;
  evaluate(
    batch: DecisionBatch,
    context: {
      /** Explicit model selected by the host's decisionModel role. */
      readonly model: string;
      readonly agentId?: string;
      /** Composed by host from caller, per-call deadline, and retirement. */
      readonly signal: AbortSignal;
      /** Deadline on the same process-local performance.now() time base. */
      readonly deadlineMonotonicMs: number;
    },
  ): Promise<ProviderDecisionOutcome>;
}

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
      /** Trusted consumer task identity; never inferred from purpose or user input. */
      readonly taskId?: DecisionTaskId;
      readonly purpose: string;
      readonly rubricVersion: string;
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
    },
  ): Promise<DecisionOutcome>;
}

// Caller cancellation, closed host authority, and programmer/contract errors
// reject rather than becoming an unavailable result. The host recognizes its
// own deadline/retirement abort separately while preserving caller cancellation.
