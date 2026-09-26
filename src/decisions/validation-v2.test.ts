import { normalizeModelCatalog } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it, vi } from "vitest";
import type { DecisionBatchV2 } from "./types-v2.js";
import { validateDecisionBatchV2, validateDecisionResultV2 } from "./validation-v2.js";
import { DecisionContractError } from "./validation.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "synthetic evidence" },
  questions: {
    truth: { type: "boolean" },
    pick: { type: "choice", criteria: { yes: "yes", no: "no" } },
    rank: { type: "score", criteria: ["low", "middle", "high"] },
  },
};
function result() {
  return {
    model: "synthetic-model",
    answers: {
      truth: { type: "boolean", probabilityTrue: 0.9, answer: null },
      pick: {
        type: "choice",
        choice: null,
        probabilities: { yes: 0, no: 0 },
        probability: null,
        confidence: null,
      },
      rank: { type: "score", score: 1.25, metadata: { reasoning: ["reported", { detail: true }] } },
    },
    usage: {
      inputTokens: 0,
      outputTokens: 2,
      costUsd: 0.003,
      units: { unit: "decision-units", amount: 1.5 },
      raw: { reported: true },
    },
    metadata: { route: "synthetic" },
  };
}
const listBatch: DecisionBatchV2 = {
  state: {
    type: "list",
    items: [
      { id: "a", content: "a" },
      { id: "b", content: { value: 2 } },
    ],
  },
  questions: {
    sort: { type: "sort" },
    tags: { type: "tags", criteria: { red: "red", blue: "blue" } },
  },
};
function listResult() {
  return {
    model: "synthetic-model",
    answers: {
      sort: { type: "sort", order: ["b", "a"], confidence: 2.5 },
      tags: {
        type: "tags",
        tags: [
          { id: "blue", probability: 0, applies: null },
          { id: "red", probability: 0.9, applies: false },
        ],
      },
    },
  };
}

describe("V2 decision admission", () => {
  it.each(["categorical", "independent", "provider-defined"] as const)(
    "checks declared %s estimates after canonical normalization without renormalizing them",
    (semantics) => {
      const declared = {
        protocol: "fixture-native",
        input: ["text"],
        questions: {
          boolean: { probabilities: "boolean", abstention: true },
          choice: { probabilities: semantics, abstention: true },
          score: { probabilities: semantics, abstention: false },
        },
      } satisfies ModelDecisionCapabilities;
      const capabilities = normalizeModelCatalog(
        {
          providers: {
            fixture: { models: [{ id: "native", inference: { chat: false, decision: declared } }] },
          },
        },
        { ownedProviders: new Set(["fixture"]) },
      )?.providers?.fixture?.models[0]?.inference?.decision;
      if (!capabilities) {
        throw new Error("Missing declared route");
      }
      const value = {
        model: "native",
        answers: {
          truth: { type: "boolean", probabilityTrue: 0.95, answer: false },
          pick: { type: "choice", choice: "no", probabilities: { yes: 0.8, no: 0.19 } },
          rank: { type: "score", score: 1.25, probabilities: [0.33, 0.33, 0.33] },
        },
      };
      const before = structuredClone(value);
      expect(validateDecisionResultV2(batch, value, capabilities)).toBe(true);
      expect(value).toEqual(before);
      // Choice/Score categorical distributions require positive mass, including
      // rounded TypeSafe-style reports. Independent abstention does not.
      for (const answers of [
        {
          ...value.answers,
          pick: { type: "choice", choice: null, probabilities: { yes: 0, no: 0 } },
        },
        { ...value.answers, rank: { type: "score", score: 1.25, probabilities: [0, 0, 0] } },
      ]) {
        expect(validateDecisionResultV2(batch, { ...value, answers }, capabilities)).toBe(
          semantics !== "categorical",
        );
      }
      expect(value).not.toHaveProperty("usage");
    },
  );

  it("keeps declared no-probability answers and five-level fractional scores honest", () => {
    const scaleBatch: DecisionBatchV2 = {
      state: { type: "text", text: "explicit evidence" },
      questions: {
        truth: { type: "boolean" },
        scale: { type: "score", criteria: ["never", "rarely", "sometimes", "often", "always"] },
      },
    };
    const capabilities: ModelDecisionCapabilities = {
      protocol: "fixture-scale",
      input: ["text"],
      questions: {
        boolean: { probabilities: "none", abstention: true },
        score: { probabilities: "none", abstention: false, minOptions: 5, maxOptions: 5 },
      },
    };
    const value = {
      model: "native",
      answers: { truth: { type: "boolean", answer: null }, scale: { type: "score", score: 2.5 } },
    };
    expect(validateDecisionResultV2(scaleBatch, value, capabilities)).toBe(true);
    expect(value.answers.truth).not.toHaveProperty("probabilityTrue");
    expect(value.answers.scale).not.toHaveProperty("probabilities");
    expect(value).not.toHaveProperty("usage");
    expect(
      validateDecisionResultV2(
        scaleBatch,
        { ...value, usage: { costUsd: 0, units: { unit: "requests", amount: 1 } } },
        capabilities,
      ),
    ).toBe(true);
    for (const answers of [
      { ...value.answers, truth: { type: "boolean", answer: null, probabilityTrue: 0 } },
      { ...value.answers, scale: { type: "score", score: 2.5, probabilities: [0, 0, 0, 0, 0] } },
      { ...value.answers, scale: { type: "score", score: 4.01 } },
    ]) {
      expect(validateDecisionResultV2(scaleBatch, { ...value, answers }, capabilities)).toBe(false);
    }
  });

  it("enforces declared tag abstention/probabilities without erasing per-question failures", () => {
    const capabilities: ModelDecisionCapabilities = {
      protocol: "fixture-tags",
      input: ["text"],
      questions: {
        sort: { probabilities: "none", abstention: false },
        tags: { probabilities: "none", abstention: false },
      },
    };
    const value = {
      model: "native",
      answers: {
        sort: { type: "error", code: "unsupported-input" },
        tags: {
          type: "tags",
          tags: [
            { id: "red", applies: false },
            { id: "blue", applies: true },
          ],
        },
      },
    };
    expect(validateDecisionResultV2(listBatch, value, capabilities)).toBe(true);
    for (const tags of [
      [
        { id: "red", applies: null },
        { id: "blue", applies: true },
      ],
      [
        { id: "red", applies: false, probability: 0 },
        { id: "blue", applies: true },
      ],
    ]) {
      expect(
        validateDecisionResultV2(
          listBatch,
          { ...value, answers: { ...value.answers, tags: { type: "tags", tags } } },
          capabilities,
        ),
      ).toBe(false);
    }
  });

  it("accepts reported generative decisions without inventing native probabilities", () => {
    const value = {
      model: "synthetic-generative",
      answers: {
        truth: { type: "boolean", answer: false },
        pick: { type: "choice", choice: "yes" },
        rank: { type: "score", score: 1.5 },
      },
    };
    expect(validateDecisionResultV2(batch, value)).toBe(true);
    expect(value.answers.truth).not.toHaveProperty("probabilityTrue");
    expect(value.answers.pick).not.toHaveProperty("probabilities");
    expect(
      validateDecisionResultV2(batch, {
        ...value,
        answers: { ...value.answers, truth: { type: "boolean" } },
      }),
    ).toBe(false);
  });
  it("preserves abstention, independent estimates, fractional scores and reported accounting without mutation", () => {
    const value = result();
    const before = structuredClone(value);
    expect(validateDecisionBatchV2(batch)).toBe(true);
    expect(validateDecisionResultV2(batch, value)).toBe(true);
    expect(value).toEqual(before);
    expect(value.answers.rank).not.toHaveProperty("probabilities");
    expect(
      validateDecisionResultV2(batch, {
        ...value,
        answers: { ...value.answers, truth: { type: "boolean", probabilityTrue: 0.9 } },
      }),
    ).toBe(true);
    expect(
      validateDecisionResultV2(batch, {
        ...value,
        answers: {
          ...value.answers,
          pick: {
            type: "choice",
            choice: "no",
            probabilities: { yes: 0.9, no: 0.1 },
            probability: 0.2,
            confidence: -2,
          },
        },
      }),
    ).toBe(true);
  });

  it("retains per-question errors alongside usable answers", () => {
    const value = result();
    expect(
      validateDecisionResultV2(batch, {
        ...value,
        answers: {
          ...value.answers,
          pick: { type: "error", code: "provider-error", providerCode: "x".repeat(128) },
        },
      }),
    ).toBe(true);
    for (const error of [
      { type: "error", code: "bad" },
      { type: "error", code: ["provider-error"] },
      { type: "error", code: "provider-error", providerCode: "x".repeat(129) },
      { type: "error", code: "provider-error", metadata: {} },
    ]) {
      expect(
        validateDecisionResultV2(batch, { ...value, answers: { ...value.answers, pick: error } }),
      ).toBe(false);
    }
  });

  it("requires exact answer identities and rejects ignored or malformed fields", () => {
    const value = result();
    for (const invalid of [
      { ...value, answers: { ...value.answers, extra: value.answers.truth } },
      { ...value, answers: { truth: value.answers.truth } },
      { ...value, model: "" },
      { ...value, model: "x".repeat(257) },
      { ...value, grounding: {} },
      { ...value, metadata: [] },
      { ...value, usage: { costUsd: -1 } },
      { ...value, usage: { units: { unit: "tokens", amount: 1 } } },
      { ...value, usage: { units: { unit: "requests", amount: Infinity } } },
      { ...value, usage: { ignored: 2 } },
      { ...value, usage: { raw: undefined } },
      {
        ...value,
        answers: {
          ...value.answers,
          truth: { type: "boolean", probabilityTrue: 0.5, confidence: 1 },
        },
      },
      {
        ...value,
        answers: {
          ...value.answers,
          pick: { type: "choice", choice: "missing", probabilities: { yes: 0, no: 0 } },
        },
      },
      {
        ...value,
        answers: {
          ...value.answers,
          pick: { type: "choice", choice: null, probabilities: { yes: 0 } },
        },
      },
      { ...value, answers: { ...value.answers, rank: { type: "score", score: 2.1 } } },
      {
        ...value,
        answers: { ...value.answers, rank: { type: "score", score: 1, probabilities: [0.5, 0.5] } },
      },
    ]) {
      expect(validateDecisionResultV2(batch, invalid)).toBe(false);
    }
    for (const n of [-0.01, 1.01, Number.NaN, Infinity]) {
      expect(
        validateDecisionResultV2(batch, {
          ...value,
          answers: { ...value.answers, truth: { type: "boolean", probabilityTrue: n } },
        }),
      ).toBe(false);
    }
  });

  it("validates native sort and tags identities without sorting or thresholding", () => {
    const value = listResult();
    expect(validateDecisionBatchV2(listBatch)).toBe(true);
    expect(
      validateDecisionBatchV2({
        state: { type: "list", items: [] },
        questions: { sort: { type: "sort" } },
      }),
    ).toBe(true);
    expect(validateDecisionResultV2(listBatch, value)).toBe(true);
    for (const order of [["a", "a"], ["a"], ["a", "c"], ["a", "b", "c"]]) {
      expect(
        validateDecisionResultV2(listBatch, {
          ...value,
          answers: { ...value.answers, sort: { type: "sort", order } },
        }),
      ).toBe(false);
    }
    for (const tags of [
      [{ id: "red", probability: 1, applies: true }],
      [
        { id: "red", probability: 1, applies: true },
        { id: "red", probability: 0, applies: false },
      ],
      [
        { id: "red", probability: 1, applies: true },
        { id: "other", probability: 0, applies: null },
      ],
      [
        { id: "red", probability: 1, applies: true },
        { id: "blue", probability: 0 },
      ],
    ]) {
      expect(
        validateDecisionResultV2(listBatch, {
          ...value,
          answers: { ...value.answers, tags: { type: "tags", tags } },
        }),
      ).toBe(false);
    }
  });

  it("rejects malformed caller shapes, unknown options, and sort without list evidence", () => {
    for (const invalid of [
      null,
      {},
      { ...batch, grounding: {} },
      { ...batch, state: "implicit" },
      { ...batch, state: { type: "json" } },
      { ...batch, state: { type: "list", items: [{ id: "", content: null }] } },
      {
        ...batch,
        state: {
          type: "list",
          items: [
            { id: "a", content: null },
            { id: "a", content: null },
          ],
        },
      },
      { ...batch, questions: {} },
      { ...batch, questions: { q: { type: "sort" } } },
      { ...batch, questions: { q: { type: "boolean", instructions: 1 } } },
      { ...batch, questions: { q: { type: "boolean", criteria: { ignored: "x" } } } },
      { ...batch, questions: { q: { type: "tags", criteria: {} } } },
    ]) {
      expect(() => validateDecisionBatchV2(invalid)).toThrow(DecisionContractError);
    }
    for (const value of [null, true, 1.5, "explicit json", [1, false], { value: 2 }]) {
      expect(validateDecisionBatchV2({ ...batch, state: { type: "json", value } })).toBe(true);
    }
  });

  it("rejects getters, proxies, cycles, hidden/symbol data and sparse arrays without execution", () => {
    const getter = vi.fn(() => "unexpected");
    const trap = vi.fn(() => {
      throw new Error("unexpected");
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const sparse: unknown[] = [];
    sparse.length = 2;
    const invalid = [
      Object.defineProperty({}, "value", { get: getter, enumerable: true }),
      new Proxy({}, { getPrototypeOf: trap, ownKeys: trap, get: trap }),
      revoked.proxy,
      cycle,
      { nested: { value: undefined } },
      Object.defineProperty({}, "hidden", { value: 1 }),
      { [Symbol("hidden")]: 1 },
      sparse,
      Object.assign([1], { extra: 2 }),
      new Date(0),
      { n: Number.NaN },
    ];
    for (const value of invalid) {
      expect(() => validateDecisionBatchV2({ ...batch, state: { type: "json", value } })).toThrow(
        DecisionContractError,
      );
      expect(validateDecisionResultV2(batch, { ...result(), metadata: value })).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    const shared = { value: 1 };
    expect(
      validateDecisionBatchV2({
        ...batch,
        state: { type: "json", value: { left: shared, right: shared } },
      }),
    ).toBe(true);
    expect(
      validateDecisionBatchV2({
        ...batch,
        state: { type: "json", value: Object.assign(Object.create(null), { value: 1 }) },
      }),
    ).toBe(true);
  });

  it("enforces finite JSON, question and list resource bounds", () => {
    const questions = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { type: "boolean" }]));
    expect(validateDecisionBatchV2({ ...batch, questions: questions(256) })).toBe(true);
    expect(validateDecisionBatchV2({ ...batch, questions: questions(257) })).toBe(false);
    const list = (n: number) => ({
      type: "list",
      items: Array.from({ length: n }, (_, i) => ({ id: String(i), content: null })),
    });
    expect(validateDecisionBatchV2({ ...listBatch, state: list(120) })).toBe(true);
    expect(validateDecisionBatchV2({ ...listBatch, state: list(121) })).toBe(false);
    const empty = { state: { type: "text", text: "" }, questions: { q: { type: "boolean" } } };
    const remaining = 1_048_576 - Buffer.byteLength(JSON.stringify({ ...empty, state: "" }));
    expect(
      validateDecisionBatchV2({ ...empty, state: { type: "text", text: "x".repeat(remaining) } }),
    ).toBe(true);
    expect(
      validateDecisionBatchV2({
        ...empty,
        state: { type: "text", text: "x".repeat(remaining + 1) },
      }),
    ).toBe(false);
    expect(
      validateDecisionBatchV2({
        ...batch,
        state: { type: "json", value: Array.from({ length: 20_001 }, () => null) },
      }),
    ).toBe(false);
    let deep: unknown = null;
    for (let i = 0; i < 34; i++) {
      deep = { nested: deep };
    }
    expect(validateDecisionBatchV2({ ...batch, state: { type: "json", value: deep } })).toBe(false);
    expect(
      validateDecisionResultV2(batch, { ...result(), metadata: { text: "x".repeat(1_048_576) } }),
    ).toBe(false);
  });

  it("admits only canonical PNG/JPEG/WebP data URIs with a 4 MiB decoded ceiling", () => {
    for (const mime of ["png", "jpeg", "webp"]) {
      expect(
        validateDecisionBatchV2({
          ...batch,
          state: {
            type: "image",
            dataUri: "data:image/" + mime + ";base64,AA==",
            text: "explicit",
          },
        }),
      ).toBe(true);
    }
    for (const dataUri of [
      "https://example.invalid/image.png",
      "file:///image.png",
      "data:image/gif;base64,AA==",
      "data:image/png;base64,",
      "data:image/png;base64,AB==",
      "data:image/png;base64,AAB=",
      "data:image/png;base64,AA",
      "data:image/png;base64,AA== ",
      "data:image/png;base64,=AAA",
      "data:image/png;base64,AA_A",
      "data:image/png;charset=utf-8;base64,AA==",
    ]) {
      expect(() =>
        validateDecisionBatchV2({ ...batch, state: { type: "image", dataUri } }),
      ).toThrow(DecisionContractError);
    }
    const dataUri = "data:image/png;base64," + Buffer.alloc(4 * 1_048_576).toString("base64");
    expect(
      validateDecisionBatchV2({
        ...batch,
        state: { type: "image", dataUri, text: "x".repeat(1000) },
      }),
    ).toBe(true);
    const oversized = "data:image/png;base64," + Buffer.alloc(4 * 1_048_576 + 1).toString("base64");
    expect(
      validateDecisionBatchV2({ ...batch, state: { type: "image", dataUri: oversized } }),
    ).toBe(false);
    expect(
      validateDecisionBatchV2({
        ...batch,
        state: { type: "image", dataUri, text: "x".repeat(1_048_576) },
      }),
    ).toBe(false);
  });
});
