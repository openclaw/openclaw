import type { ProviderPlugin } from "../plugins/provider-plugin.types.js";
import type { DecisionProviderContextV2 } from "./provider-context.js";
import type { DecisionBatchV2, ProviderDecisionOutcomeV2 } from "./types-v2.js";
import type { DecisionBatch, ProviderDecisionOutcome } from "./types.js";

export interface DecisionProviderV1 {
  readonly id: string;
  readonly contractVersion: 1;
  /** Prepared local credential availability only; must not perform I/O.
   * Omission leaves readiness unconfirmed without blocking evaluation. */
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
      /** Host-owned request admission. Check synchronously immediately before external I/O.
       * False closes this evaluation; a thrown authority assertion remains terminal.
       * Omission preserves explicit evaluations and older hosts. */
      readonly isAdmissible?: () => boolean;
    },
  ): Promise<ProviderDecisionOutcome>;
}

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
