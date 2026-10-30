import { describe, expect, it } from "vitest";
import { decodeSystemOneResponse, encodeSystemOneQuestions } from "./systemone-codec.js";
import type { DecisionBatchV2 } from "./types-v2.js";
import { validateDecisionResultV2 } from "./validation-v2.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "Synthetic ticket" },
  questions: {
    b: { type: "boolean", criteria: { true: "Urgent", false: null } },
    c: { type: "choice", criteria: { a: null, b: "Billing" } },
    s: { type: "score", criteria: ["Low", null] },
  },
};

function wire() {
  return {
    model: "fixture-version",
    provider: "Fixture",
    answers: {
      b: { type: "noul", noul: 0.37 },
      c: { type: "choice", choice: "a", probabilities: { a: 0.49, b: 0.5 }, confidence: 0.1 },
      s: { type: "score", score: 0.71, probabilities: { "1": 0.69, "0": 0.3 }, confidence: 0.2 },
    },
    usage: { input_tokens: 3, output_tokens: 0 },
  };
}

describe("System One wire codec", () => {
  it("renames boolean questions without changing instructions or criteria", () => {
    expect(encodeSystemOneQuestions(batch)).toEqual({
      ...batch.questions,
      b: { type: "noul", criteria: { true: "Urgent", false: null } },
    });
    expect(batch.questions.b?.type).toBe("boolean");
  });

  it("preserves native scores, rounded distributions, model identity and usage", () => {
    const result = decodeSystemOneResponse(batch, wire());
    expect(validateDecisionResultV2(batch, result)).toBe(true);
    expect(result).toEqual({
      model: "fixture-version",
      metadata: { provider: "Fixture" },
      answers: {
        b: { type: "boolean", probabilityTrue: 0.37 },
        c: { type: "choice", choice: "a", probabilities: { a: 0.49, b: 0.5 }, confidence: 0.1 },
        s: { type: "score", score: 0.71, probabilities: [0.3, 0.69], confidence: 0.2 },
      },
      usage: { inputTokens: 3, outputTokens: 0 },
    });
  });

  it("keeps zero cost distinct from absent cost and retains additional usage", () => {
    expect(decodeSystemOneResponse(batch, wire())).toHaveProperty("usage", {
      inputTokens: 3,
      outputTokens: 0,
    });
    expect(
      decodeSystemOneResponse(batch, {
        ...wire(),
        usage: { input_tokens: 3, output_tokens: 0, cost: 0, provider_units: 1 },
      }),
    ).toHaveProperty("usage", {
      inputTokens: 3,
      outputTokens: 0,
      costUsd: 0,
      raw: { input_tokens: 3, output_tokens: 0, cost: 0, provider_units: 1 },
    });
  });

  it.each([{ "0": 1 }, { "0": 0.3, "2": 0.7 }, { "0": 0.3, "1": 0.7, "2": 0 }])(
    "rejects missing, extra or misindexed score probabilities: %j",
    (probabilities) => {
      const response = wire();
      const result = decodeSystemOneResponse(batch, {
        ...response,
        answers: { ...response.answers, s: { ...response.answers.s, probabilities } },
      });
      expect(validateDecisionResultV2(batch, result)).toBe(false);
    },
  );

  it.each([undefined, null, -0.1, 1.1, Number.NaN, "0.5"])(
    "rejects malformed or absent required confidence: %s",
    (confidence) => {
      const response = wire();
      const result = decodeSystemOneResponse(batch, {
        ...response,
        answers: { ...response.answers, c: { ...response.answers.c, confidence } },
      });
      expect(validateDecisionResultV2(batch, result)).toBe(false);
    },
  );
});
