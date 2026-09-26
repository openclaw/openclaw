import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { normalizeManifestModelCatalog } from "../plugins/manifest-decision-catalog.js";
import {
  decisionBatchV1ToV2,
  decisionBatchV2ToV1,
  decisionResultV1ToV2,
  decisionResultV2ToV1,
} from "./compatibility.js";
import type {
  DecisionAnswerV2,
  DecisionBatchResultV2,
  DecisionBatchV2,
  DecisionRuntimeV2,
} from "./types-v2.js";
import type {
  DecisionAnswer,
  DecisionBatch,
  DecisionBatchResult,
  DecisionRuntimeV1,
} from "./types.js";
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

describe("explicit decision version conversion", () => {
  it("keeps V1 source-compatible while requiring an actual V2 boolean report", () => {
    expectTypeOf<DecisionRuntimeV2["evaluate"]>().toEqualTypeOf<DecisionRuntimeV1["evaluate"]>();
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
    const capabilities = normalizeManifestModelCatalog({
      modelCatalog: undefined,
      providers: [],
      cliBackends: [],
      decisionProviders: ["fixture"],
      decisionModels: [
        {
          provider: "fixture",
          id: result.model,
          name: "Fixture",
          capabilities: { questionTypes: ["boolean", "choice", "score"] },
        },
      ],
    })?.providers?.fixture?.models[0]?.inference?.decision;
    if (!capabilities) {
      throw new Error("Missing fixture capabilities");
    }
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
    expect(converted).toEqual(reported);
    expect(converted).not.toHaveProperty("usage");
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
    const v1Getter: DecisionBatch = {
      questions: batch.questions,
      get state() {
        return getter();
      },
    };
    const v2Getter: DecisionBatchV2 = {
      questions: v2Batch.questions,
      get state() {
        getter();
        return v2Batch.state;
      },
    };
    const resultGetter: DecisionBatchResult = {
      model: result.model,
      get answers() {
        getter();
        return result.answers;
      },
    };
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
    expect(validateDecisionBatch(boundary)).toBe(true);
    const converted = decisionBatchV1ToV2(boundary);
    expect(converted).toBeDefined();
    expect(converted && decisionBatchV2ToV1(converted)).toEqual(boundary);
  });
  it("round-trips representable evidence and estimates without thresholding, argmax or normalization", () => {
    const before = structuredClone({ batch, result });
    expect(decisionBatchV1ToV2(batch)).toEqual(v2Batch);
    expect(decisionBatchV2ToV1(v2Batch)).toEqual(batch);
    const converted = decisionResultV1ToV2(batch, result);
    expect(converted).toEqual(result);
    expect(converted?.answers.boolean).not.toHaveProperty("answer");
    expect(converted?.answers.choice).not.toHaveProperty("probability");
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
    ];
    for (const input of inputs) {
      expect(decisionBatchV2ToV1(input)).toBeUndefined();
    }
  });

  it("refuses to drop abstention, explicit decisions, errors, missing distributions or metadata", () => {
    const answers: DecisionBatchResultV2["answers"][] = [
      { ...result.answers, boolean: { type: "boolean", probabilityTrue: 0.99, answer: null } },
      { ...result.answers, boolean: { type: "boolean", probabilityTrue: 0.99, answer: false } },
      {
        ...result.answers,
        choice: { type: "choice", choice: null, probabilities: { yes: 0, no: 0 } },
      },
      {
        ...result.answers,
        choice: { type: "choice", choice: "no", probabilities: { yes: 0, no: 0 } },
      },
      {
        ...result.answers,
        choice: {
          type: "choice",
          choice: "no",
          probabilities: { yes: 0.8, no: 0.2 },
          probability: 0.2,
        },
      },
      {
        ...result.answers,
        choice: {
          type: "choice",
          choice: "no",
          probabilities: { yes: 0.8, no: 0.2 },
          confidence: null,
        },
      },
      { ...result.answers, score: { type: "score", score: 1.3 } },
      { ...result.answers, score: { type: "score", score: 1.3, probabilities: [0, 0, 0] } },
      {
        ...result.answers,
        boolean: { type: "boolean", probabilityTrue: 0.99, metadata: { reasoning: "reported" } },
      },
      {
        ...result.answers,
        boolean: { type: "error", code: "provider-error", providerCode: "synthetic" },
      },
    ];
    for (const answer of answers) {
      expect(decisionResultV2ToV1(v2Batch, { ...result, answers: answer })).toBeUndefined();
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
    expect(validateDecisionBatch(batch)).toBe(true);
    expect(validateDecisionResult(batch, result)).toBe(true);
    expect(
      validateDecisionResult(batch, {
        ...result,
        answers: {
          ...result.answers,
          choice: { type: "choice", choice: "no", probabilities: { yes: 0, no: 0 } },
        },
      }),
    ).toBe(false);
    expect(
      validateDecisionResult(batch, {
        ...result,
        answers: { ...result.answers, score: { type: "score", score: 1.3 } },
      }),
    ).toBe(false);
    expect(validateDecisionResult(batch, { ...result, usage: { costUsd: 1 } })).toBe(false);
    expect(validateDecisionBatch({ ...batch, state: "x".repeat(1_048_576) })).toBe(false);
    expect(decisionBatchV1ToV2({ ...batch, state: "x".repeat(1_048_576) })).toBeUndefined();
    expect(decisionResultV1ToV2(batch, { ...result, model: "" })).toBeUndefined();
  });
});
