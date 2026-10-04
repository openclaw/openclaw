import type { DecisionAnswer, DecisionBatch, DecisionOutcome } from "../../decisions/types.js";

export function judgment(batch: DecisionBatch, choices: Record<string, string>): DecisionOutcome {
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(batch.questions)) {
    if (question.type !== "choice") {
      throw new Error("The fixture requires Choice questions");
    }
    const selected = Object.hasOwn(question.criteria, "engagement")
      ? choices.attention
      : Object.hasOwn(question.criteria, "opening")
        ? "opening"
        : choices[id];
    if (!selected || !Object.hasOwn(question.criteria, selected)) {
      throw new Error(`The decision fixture has no valid answer for ${id}`);
    }
    answers[id] = {
      type: "choice",
      choice: selected,
      probabilities: Object.fromEntries(
        Object.keys(question.criteria).map((key) => [key, key === selected ? 1 : 0]),
      ),
    };
  }
  return {
    status: "ok",
    result: { model: "synthetic-decision", answers },
    provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "fixture" },
  };
}
