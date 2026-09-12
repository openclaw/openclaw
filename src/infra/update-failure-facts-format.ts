import type { UpdateFailureFact } from "./update-failure-facts.js";

/** Keep the first failing check visible when later recovery failures fill the summary. */
export function selectUpdateFailureReportSteps<
  T extends { failureFacts?: readonly UpdateFailureFact[] },
>(steps: readonly T[]): readonly T[] {
  const recent = steps.slice(-3);
  const firstFact = steps.find((step) => (step.failureFacts?.length ?? 0) > 0);
  return firstFact && !recent.includes(firstFact) ? [firstFact, ...recent.slice(-2)] : recent;
}

/** Render producer-redacted facts in both server and browser reports. */
export function formatUpdateFailureFact(fact: UpdateFailureFact): string {
  return `Failing check ${fact.check} (${fact.code})${fact.pluginId ? `; plugin ${fact.pluginId}` : ""}${fact.affectedKey ? `; key ${fact.affectedKey}` : ""}${fact.message ? `: ${fact.message}` : ""}`;
}
