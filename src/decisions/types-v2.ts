import type {
  DecisionEntry,
  DecisionOutcome,
  DecisionQuestion,
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
