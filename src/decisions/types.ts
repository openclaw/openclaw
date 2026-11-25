import type { DecisionEntry, DecisionQuestion } from "./input-types.js";

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
