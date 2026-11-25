import { finalizePluginModelUsage } from "../plugins/runtime/runtime-model-usage.js";
import type { DecisionOutcome, DecisionOutcomeV2 } from "./host-outcomes.js";

type Outcome = DecisionOutcome | DecisionOutcomeV2;
export type DecisionEvaluation<T extends Outcome = Outcome> = {
  outcome: T;
  usageFacts?: Pick<
    Parameters<typeof finalizePluginModelUsage>[0],
    "cfg" | "hostPluginId" | "target" | "preparedBilling"
  >;
};

/** Complete only at the caller's successful return, after its late guards and projection. */
export function completeDecisionEvaluation<T extends Outcome>(
  evaluation: DecisionEvaluation<T>,
): T {
  if (evaluation.outcome.status === "ok" && evaluation.usageFacts) {
    finalizePluginModelUsage({
      ...evaluation.usageFacts,
      rawUsage: evaluation.outcome.result.usage,
      estimate: "none",
    });
  }
  return evaluation.outcome;
}
