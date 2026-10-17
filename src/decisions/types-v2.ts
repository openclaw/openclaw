import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import type { DecisionProviderContextV2 } from "./provider-context.js";
import type {
  DecisionEntry,
  DecisionOutcome,
  DecisionQuestion,
  DecisionRuntimeV1,
  JsonValue,
  ProviderDecisionOutcome,
} from "./types.js";

/** Explicit evidence supplied by the caller; the host collects no additional context. */
export type DecisionContentV2 =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "json"; readonly value: JsonValue }
  | { readonly type: "image"; readonly dataUri: string; readonly text?: string }
  | {
      readonly type: "list";
      readonly items: readonly { readonly id: string; readonly content: DecisionEntry }[];
    };

export type DecisionQuestionV2 =
  | DecisionQuestion
  | { readonly type: "sort"; readonly instructions?: DecisionEntry }
  | {
      readonly type: "tags";
      readonly instructions?: DecisionEntry;
      readonly criteria: Readonly<Record<string, DecisionEntry>>;
    };

export type DecisionBatchV2 = {
  readonly state: DecisionContentV2;
  readonly questions: Readonly<Record<string, DecisionQuestionV2>>;
};

export type DecisionAnswerV2 =
  | ((
      | ({
          readonly type: "boolean";
        } & (
          | {
              /** Native P(true), independent from any explicit answer. */
              readonly probabilityTrue: number;
              readonly answer?: boolean | null;
            }
          | {
              /** At least answer or probabilityTrue is required; null is explicit abstention. */
              readonly answer: boolean | null;
              readonly probabilityTrue?: number;
            }
        ))
      | {
          readonly type: "choice";
          readonly choice: string | null;
          /** Route-declared estimates; independent maps may be all-zero. Never normalized. */
          readonly probabilities?: Readonly<Record<string, number>>;
          /** Selected provider estimate, not derived from the map. */
          readonly probability?: number | null;
          readonly confidence?: number | null;
        }
      | {
          readonly type: "score";
          readonly score: number;
          /** An absent distribution must not be synthesized. */
          readonly probabilities?: readonly number[];
          readonly confidence?: number | null;
        }
      | {
          readonly type: "sort";
          readonly order: readonly string[];
          readonly confidence?: number | null;
        }
      | {
          readonly type: "tags";
          readonly tags: readonly {
            readonly id: string;
            readonly probability?: number;
            readonly applies: boolean | null;
          }[];
        }
    ) & { readonly metadata?: Readonly<Record<string, JsonValue>> })
  | {
      readonly type: "error";
      readonly code: "unsupported-input" | "invalid-input" | "provider-error";
      readonly providerCode?: string;
    };

export type DecisionBatchResultV2 = {
  readonly model: string;
  readonly answers: Readonly<Record<string, DecisionAnswerV2>>;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costUsd?: number;
    readonly units?: {
      readonly unit: "decision-units" | "requests";
      readonly amount: number;
    };
    readonly raw?: JsonValue;
  };
  readonly metadata?: Readonly<Record<string, JsonValue>>;
};

export type ProviderDecisionOutcomeV2 =
  | { readonly status: "ok"; readonly result: DecisionBatchResultV2 }
  | Extract<ProviderDecisionOutcome, { status: "unavailable" }>;

export type DecisionOutcomeV2 =
  | {
      readonly status: "ok";
      readonly result: DecisionBatchResultV2;
      readonly provenance: Extract<DecisionOutcome, { status: "ok" }>["provenance"];
    }
  | Extract<DecisionOutcome, { status: "unavailable" }>;

/** Execution options add only provider-declared reasoning to the established caller contract. */
export type DecisionEvaluateOptionsV2 = Parameters<DecisionRuntimeV1["evaluate"]>[1] & {
  readonly reasoning?: DecisionProviderContextV2["reasoning"];
};

/** Shares normal model catalog, route and credential ownership with conversational inference. */
export interface DecisionProviderV2 {
  readonly id: string;
  readonly contractVersion: 2;
  /** Omit when this plugin has already registered the same normal provider. */
  readonly provider?: Omit<ProviderPlugin, "id">;
  evaluate(
    batch: DecisionBatchV2,
    context: DecisionProviderContextV2,
  ): Promise<ProviderDecisionOutcomeV2>;
}

export interface DecisionRuntimeV2 extends DecisionRuntimeV1 {
  evaluateV2(
    batch: DecisionBatchV2,
    options: DecisionEvaluateOptionsV2,
  ): Promise<DecisionOutcomeV2>;
}
