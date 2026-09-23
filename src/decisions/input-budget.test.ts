import { describe, expect, it } from "vitest";
import { decisionInputBudgetIssue, estimateDecisionInput } from "./input-budget.js";
import type { DecisionBatch } from "./types.js";
import { validateDecisionBatch } from "./validation.js";

const batch: DecisionBatch = {
  state: "Evidence",
  questions: {
    a: { type: "choice", instructions: "Pick one", criteria: { yes: "Yes", no: "No" } },
  },
};
const estimate = (
  value: DecisionBatch,
  scope: "encoded-question" | "state-plus-each-criterion" = "encoded-question",
) => {
  expect(validateDecisionBatch(value)).toBe(true);
  return estimateDecisionInput(value, scope);
};

describe("Decision estimated input accounting", () => {
  it("uses state plus longest question, while total accounts for every question and state once", () => {
    const one = estimate(batch);
    const twoBatch = { ...batch, questions: { a: batch.questions.a!, b: batch.questions.a! } };
    const two = estimate(twoBatch);
    expect(two.estimatedMaxInputTokens).toBe(one.estimatedMaxInputTokens);
    expect(two.estimatedTotalInputTokens).toBeGreaterThan(one.estimatedTotalInputTokens);
    expect(two.questionCount).toBe(2);
    expect(two.criterionCount).toBe(4);
    const largerState = estimate({ ...twoBatch, state: "Evidence" + "x".repeat(400) });
    expect(largerState.estimatedMaxInputTokens - two.estimatedMaxInputTokens).toBe(100);
    expect(largerState.estimatedTotalInputTokens - two.estimatedTotalInputTokens).toBe(100);
    expect(
      decisionInputBudgetIssue(
        {
          questionTypes: ["choice"],
          inputTokenScope: "encoded-question",
          maxInputTokens: two.estimatedMaxInputTokens,
          maxTotalInputTokens: one.estimatedTotalInputTokens,
        },
        two,
      ),
    ).toBe("estimated-budget-exceeded");
  });

  it("counts each criterion pair independently rather than summing alternatives into its per-input limit", () => {
    const encoded = estimate(batch);
    const pairs = estimate(batch, "state-plus-each-criterion");
    expect(pairs.estimatedMaxInputTokens).toBeLessThan(encoded.estimatedMaxInputTokens);
    expect(pairs.estimatedTotalInputTokens).toBe(encoded.estimatedTotalInputTokens);
    const changed = estimate(
      {
        ...batch,
        questions: {
          a: { type: "choice", instructions: "x".repeat(400), criteria: { yes: "Yes", no: "No" } },
        },
      },
      "state-plus-each-criterion",
    );
    expect(changed.estimatedMaxInputTokens).toBeGreaterThan(pairs.estimatedMaxInputTokens + 90);
    const boundary = {
      questionTypes: ["choice" as const],
      inputTokenScope: "state-plus-each-criterion" as const,
      maxInputTokens: pairs.estimatedMaxInputTokens,
      maxTotalInputTokens: pairs.estimatedTotalInputTokens,
    };
    expect(decisionInputBudgetIssue(boundary, pairs)).toBeUndefined();
    expect(decisionInputBudgetIssue(boundary, encoded)).toBe("estimated-budget-exceeded");
  });

  it("accounts for structured Unicode evidence, omitted Boolean alternatives, labels and extra admitted JSON", () => {
    const unicode = estimate({ state: { text: "問題😀" }, questions: { q: { type: "boolean" } } });
    const ascii = estimate({ state: { text: "abcde" }, questions: { q: { type: "boolean" } } });
    expect(unicode.estimatedMaxInputTokens).toBeGreaterThan(ascii.estimatedMaxInputTokens);
    expect(unicode.criterionCount).toBe(2);
    expect(unicode.overhead).toBe("heuristic");
    const withExtra = { ...batch, extension: "x".repeat(400) };
    expect(estimate(withExtra).estimatedMaxInputTokens).toBeGreaterThan(
      estimate(batch).estimatedMaxInputTokens + 90,
    );
    expect(estimate(withExtra).estimatedTotalInputTokens).toBeGreaterThan(
      estimate(batch).estimatedTotalInputTokens + 90,
    );
  });
});
