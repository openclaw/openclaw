import { expect, it } from "vitest";
import {
  DecisionContractError,
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  decisionResultV2ToV1,
  validateDecisionBatchV2,
  validateDecisionResultV2,
  type DecisionBatch,
  type DecisionBatchV2,
} from "./decisions.js";

it("exposes lossless codecs and bounded validation through the public decision entrypoint", () => {
  const legacy: DecisionBatch = {
    state: "explicit fixture",
    questions: { truth: { type: "boolean" } },
  };
  const richer = decisionBatchV1ToV2(legacy);
  expect(richer).toEqual({
    state: { type: "text", text: "explicit fixture" },
    questions: legacy.questions,
  });
  if (!richer) {
    throw new Error("Representable fixture was rejected");
  }
  expect(validateDecisionBatchV2(richer)).toBe(true);
  expect(decisionBatchV2ToV1(richer)).toEqual(legacy);
  const result = {
    model: "fixture",
    answers: { truth: { type: "boolean" as const, answer: false, probabilityTrue: 0.95 } },
  };
  expect(validateDecisionResultV2(richer, result)).toBe(true);
  expect(decisionResultV2ToV1(richer, result)).toBeUndefined();
  const explicitJson: DecisionBatchV2 = {
    ...richer,
    state: { type: "json", value: "explicit fixture" },
  };
  expect(decisionBatchV2ToV1(explicitJson)).toBeUndefined();
  expect(() => validateDecisionBatchV2({ state: null, questions: {} })).toThrow(
    DecisionContractError,
  );
});
