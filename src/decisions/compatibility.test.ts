import { expect, expectTypeOf, it, vi } from "vitest";
import { normalizeCapabilities } from "./catalog.test-support.js";
import {
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  decisionResultV1ToV2,
  decisionResultV2ToV1,
} from "./compatibility.js";
import type { DecisionAnswerV2, DecisionBatchV2 } from "./types-v2.js";
import type { DecisionAnswer, DecisionBatch, DecisionBatchResult } from "./types.js";
import { validateDecisionResultV2 } from "./validation-v2.js";
import {
  DecisionContractError,
  validateDecisionBatch,
  validateDecisionResult,
} from "./validation.js";

const batch: DecisionBatch = {
  state: "synthetic evidence",
  questions: {
    boolean: { type: "boolean" },
    choice: { type: "choice", criteria: { yes: "yes", no: "no" } },
    score: { type: "score", criteria: ["low", "middle", "high"] },
  },
};
const result: DecisionBatchResult = {
  model: "synthetic-model",
  answers: {
    boolean: { type: "boolean", probabilityTrue: 0.99 },
    choice: { type: "choice", choice: "no", probabilities: { yes: 0.8, no: 0.19 }, confidence: -2 },
    score: { type: "score", score: 1.3, probabilities: [0.33, 0.33, 0.33] },
  },
  usage: { inputTokens: 0, outputTokens: 2.5 },
};
const v2Batch: DecisionBatchV2 = {
  state: { type: "text", text: "synthetic evidence" },
  questions: batch.questions,
};

it("keeps V1 source-compatible while requiring an actual V2 boolean report", () => {
  expectTypeOf<DecisionAnswer>().toMatchTypeOf<DecisionAnswerV2>();
  expectTypeOf<{ type: "boolean" }>().not.toMatchTypeOf<DecisionAnswerV2>();
  expectTypeOf<{ type: "boolean"; answer: null }>().toMatchTypeOf<DecisionAnswerV2>();
  expectTypeOf<{ type: "boolean"; probabilityTrue: number }>().toMatchTypeOf<DecisionAnswerV2>();
  expectTypeOf<{
    type: "boolean";
    answer: false;
    probabilityTrue: number;
  }>().toMatchTypeOf<DecisionAnswerV2>();
});

it("uses provider-defined V1 estimates after real metadata and result conversion", () => {
  const capabilities = normalizeCapabilities(
    {
      protocol: "fixture",
      input: ["text"],
      questions: {
        boolean: { probabilities: "boolean", abstention: false },
        choice: { probabilities: "provider-defined", abstention: false },
        score: { probabilities: "provider-defined", abstention: false },
      },
    },
    result.model,
  );
  const reported: DecisionBatchResult = {
    model: result.model,
    answers: {
      ...result.answers,
      choice: { type: "choice", choice: "no", probabilities: { yes: 0.9, no: 0.9 } },
      score: { type: "score", score: 0.25, probabilities: [0.7, 0.7, 0.7] },
    },
  };
  const converted = decisionResultV1ToV2(batch, reported);
  expect(validateDecisionResultV2(v2Batch, converted, capabilities)).toBe(true);
  expect(converted).toStrictEqual(reported);
  expect(converted && decisionResultV2ToV1(v2Batch, converted)).toEqual(reported);
  expect(capabilities.questions?.choice?.probabilities).toBe("provider-defined");
  expect(capabilities.questions?.score?.probabilities).toBe("provider-defined");
  expect(capabilities).not.toHaveProperty("billing");
  expect(capabilities).not.toHaveProperty("limits.maxInputTokens");
});

it("rejects executable caller/provider data at conversion without invoking it", () => {
  const getter = vi.fn(() => batch.state);
  const trap = vi.fn(() => {
    throw new Error("must not execute");
  });
  const withGetter = <T extends object>(value: T, key: keyof T) =>
    Object.defineProperty({ ...value }, key, {
      get: () => {
        getter();
        return value[key];
      },
    });
  const v1Getter = withGetter(batch, "state");
  const v2Getter = withGetter(v2Batch, "state");
  const resultGetter = withGetter(result, "answers");
  const revoked = Proxy.revocable(batch, {});
  revoked.revoke();
  for (const input of [v1Getter, new Proxy(batch, { get: trap, ownKeys: trap }), revoked.proxy]) {
    expect(() => decisionBatchV1ToV2(input)).toThrow(DecisionContractError);
    expect(() => decisionResultV1ToV2(input, result)).toThrow(DecisionContractError);
  }
  for (const input of [v2Getter, new Proxy(v2Batch, { get: trap, ownKeys: trap })]) {
    expect(() => decisionBatchV2ToV1(input)).toThrow(DecisionContractError);
    expect(() => decisionResultV2ToV1(input, result)).toThrow(DecisionContractError);
  }
  for (const value of [resultGetter, new Proxy(result, { get: trap, ownKeys: trap })]) {
    expect(decisionResultV1ToV2(batch, value)).toBeUndefined();
    expect(decisionResultV2ToV1(v2Batch, value)).toBeUndefined();
  }
  expect(getter).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});
it("does not charge versioned framing against an admitted V1 evidence budget", () => {
  const size = 1_048_576 - Buffer.byteLength(JSON.stringify({ ...batch, state: "" }));
  const boundary = { ...batch, state: "x".repeat(size) };
  const converted = decisionBatchV1ToV2(boundary);
  expect(converted && decisionBatchV2ToV1(converted)).toEqual(boundary);
  expect(decisionBatchV1ToV2({ ...batch, state: "x".repeat(1_048_576) })).toBeUndefined();
});
it("round-trips admitted V1 depth and node boundaries without charging V2 framing", () => {
  let nested: DecisionBatch["state"] = null;
  for (let depth = 0; depth < 31; depth++) {
    nested = [nested];
  }
  // Batch, state array, questions, question, and type consume five nodes.
  for (const state of [nested, Array.from({ length: 19_995 }, () => null)]) {
    const boundary: DecisionBatch = { state, questions: { q: { type: "boolean" } } };
    const converted = decisionBatchV1ToV2(boundary);
    expect(converted && decisionBatchV2ToV1(converted)).toEqual(boundary);
    expect(decisionBatchV1ToV2({ ...boundary, state: [state] })).toBeUndefined();
  }
});
it("round-trips representable evidence and estimates without thresholding, argmax or normalization", () => {
  const before = structuredClone({ batch, result });
  expect(decisionBatchV1ToV2(batch)).toEqual(v2Batch);
  expect(decisionBatchV2ToV1(v2Batch)).toEqual(batch);
  const converted = decisionResultV1ToV2(batch, result);
  expect(converted).toStrictEqual(result);
  expect(decisionResultV2ToV1(v2Batch, result)).toEqual(result);
  expect({ batch, result }).toEqual(before);
  for (const state of [null, [1, true], { value: "json" }]) {
    const upgraded = decisionBatchV1ToV2({ ...batch, state });
    expect(upgraded?.state).toEqual({ type: "json", value: state });
    expect(upgraded && decisionBatchV2ToV1(upgraded)).toEqual({ ...batch, state });
  }
});

it("rejects evidence and native operations before legacy dispatch", () => {
  const list: DecisionBatchV2["state"] = { type: "list", items: [{ id: "a", content: null }] };
  const inputs: DecisionBatchV2[] = [
    { ...v2Batch, state: { type: "image", dataUri: "data:image/png;base64,AA==" } },
    { ...v2Batch, state: list },
    { ...v2Batch, state: { type: "json", value: true } },
    { ...v2Batch, state: { type: "json", value: 5 } },
    { ...v2Batch, state: { type: "json", value: "explicit JSON string" } },
    { state: list, questions: { q: { type: "sort" } } },
    { ...v2Batch, questions: { q: { type: "tags", criteria: { red: "red" } } } },
    {
      state: { type: "image", dataUri: "data:image/png;base64,AA==" },
      questions: { q: { type: "box", instructions: "target" } },
    },
  ];
  for (const input of inputs) {
    expect(decisionBatchV2ToV1(input)).toBeUndefined();
  }
});

it("refuses to drop abstention, explicit decisions, errors, missing distributions or metadata", () => {
  const selected = { type: "choice" as const, choice: "no", probabilities: { yes: 0.8, no: 0.2 } };
  const answers: DecisionAnswerV2[] = [
    { type: "boolean", probabilityTrue: 0.99, answer: null },
    { type: "boolean", probabilityTrue: 0.99, answer: false },
    { type: "choice", choice: null, probabilities: { yes: 0, no: 0 } },
    { type: "choice", choice: "no", probabilities: { yes: 0, no: 0 } },
    { ...selected, probability: 0.2 },
    { ...selected, confidence: null },
    { type: "score", score: 1.3 },
    { type: "score", score: 1.3, probabilities: [0, 0, 0] },
    { type: "boolean", probabilityTrue: 0.99, metadata: { reasoning: "reported" } },
    { type: "error", code: "provider-error", providerCode: "synthetic" },
  ];
  for (const answer of answers) {
    const key = answer.type === "error" ? "boolean" : answer.type;
    expect(
      decisionResultV2ToV1(v2Batch, {
        ...result,
        answers: { ...result.answers, [key]: answer },
      }),
    ).toBeUndefined();
  }
  for (const extra of [
    { metadata: { route: "reported" } },
    { usage: { costUsd: 0 } },
    { usage: { raw: { reported: 1 } } },
    { usage: { units: { unit: "requests" as const, amount: 1 } } },
  ]) {
    expect(decisionResultV2ToV1(v2Batch, { ...result, ...extra })).toBeUndefined();
  }
});

it("retains the legacy guard semantics after shared-primitives extraction", () => {
  const answers = { ...result.answers, score: { type: "score", score: 1.3 } };
  for (const patch of [{ answers }, { usage: { costUsd: 1 } }]) {
    expect(validateDecisionResult(batch, { ...result, ...patch })).toBe(false);
  }
  expect(validateDecisionBatch({ ...batch, state: "x".repeat(1_048_576) })).toBe(false);
  expect(decisionResultV1ToV2(batch, { ...result, model: "" })).toBeUndefined();
});
