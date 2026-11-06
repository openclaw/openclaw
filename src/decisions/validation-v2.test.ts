import type {
  DecisionAnswerCapabilities,
  ModelDecisionCapabilities,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { describe, expect, it, vi } from "vitest";
import { normalizeCapabilities } from "./catalog.test-support.js";
import { DecisionContractError } from "./contract-error.js";
import { validateDecisionBatchV2 } from "./input-validation.js";
import { validateDecisionResultV2 } from "./result-validation.js";
import type { DecisionAnswerV2, DecisionBatchV2 } from "./types-v2.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "synthetic evidence" },
  questions: {
    truth: { type: "boolean" },
    pick: { type: "choice", criteria: { yes: "yes", no: "no" } },
    rank: { type: "score", criteria: ["low", "middle", "high"] },
  },
};
function result(answers: Record<string, unknown> = {}) {
  return {
    model: "synthetic-model",
    answers: {
      truth: { type: "boolean", probabilityTrue: 0.9, answer: null },
      pick: { ...choice(null, { yes: 0, no: 0 }), probability: null, confidence: null },
      rank: { type: "score", score: 1.25, metadata: { reasoning: ["reported", { detail: true }] } },
      ...answers,
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
function resultChecker(input = batch, capabilities?: DecisionAnswerCapabilities) {
  return (value: unknown, valid = true) => {
    expect(validateDecisionResultV2(input, value, capabilities)).toBe(valid);
  };
}
const expectResult = resultChecker();
function expectState(state: unknown, valid = true, input = batch) {
  expect(validateDecisionBatchV2({ ...input, state })).toBe(valid);
}
function expectAnswers(answers: Record<string, unknown>, valid = true) {
  expectResult(result(answers), valid);
}
function choice(selected: unknown, probabilities: unknown) {
  return { type: "choice", choice: selected, probabilities };
}
function tag(id: string, applies: boolean | null, probability?: number) {
  return { id, applies, ...(probability === undefined ? {} : { probability }) };
}
function listState(...ids: string[]) {
  return { type: "list", items: ids.map((id) => ({ id, content: null })) };
}
const listItems = [
  { id: "a", content: "a" },
  { id: "b", content: { value: 2 } },
];
const listBatch: DecisionBatchV2 = {
  state: { type: "list", items: listItems },
  questions: {
    sort: { type: "sort" },
    tags: { type: "tags", criteria: { red: "red", blue: "blue" } },
  },
};
const listResult = {
  model: "synthetic-model",
  answers: {
    sort: { type: "sort", order: ["b", "a"], confidence: 2.5 },
    tags: {
      type: "tags",
      tags: [tag("blue", null, 0), tag("red", false, 0.9)],
    },
  },
};

describe("V2 decision admission", () => {
  it("preserves normalized image boxes and rejects missing, inverted or out-of-range edges", () => {
    const imageBatch: DecisionBatchV2 = {
      state: { type: "image", dataUri: "data:image/png;base64,AA==" },
      questions: { target: { type: "box", instructions: "the red square" } },
    };
    const box = { top: 0.25, bottom: 0.75, left: 0.25, right: 0.76 };
    const answer = (value: unknown) => ({
      model: "fixture",
      answers: { target: { type: "box", box: value, confidence: 0.91 } },
    });
    const check = resultChecker(imageBatch);
    check(answer(box));
    for (const invalid of [
      { ...box, left: -0.1 },
      { ...box, right: 1.1 },
      { ...box, top: Number.NaN },
      { ...box, top: box.bottom },
      { ...box, left: 0.9 },
      { top: 0, bottom: 1, left: 0 },
      { ...box, width: 0.51 },
    ]) {
      check(answer(invalid), false);
    }
    for (const invalid of [
      { ...imageBatch, state: { type: "text", text: "no image" } },
      { ...imageBatch, questions: { target: { type: "box" } } },
      {
        ...imageBatch,
        questions: { target: { type: "box", instructions: "target", criteria: {} } },
      },
    ]) {
      expect(() => validateDecisionBatchV2(invalid)).toThrow(DecisionContractError);
    }
  });

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
      const capabilities = normalizeCapabilities(declared);
      const check = resultChecker(batch, capabilities);
      const value = {
        model: "native",
        answers: {
          truth: { type: "boolean", probabilityTrue: 0.95, answer: false },
          pick: choice("no", { yes: 0.8, no: 0.19 }),
          rank: { type: "score", score: 1.25, probabilities: [0.33, 0.33, 0.33] },
        },
      };
      const before = structuredClone(value);
      check(value);
      expect(value).toEqual(before);
      // Choice/Score categorical distributions require positive mass, including
      // rounded TypeSafe-style reports. Independent abstention does not.
      for (const answers of [
        { ...value.answers, pick: choice(null, { yes: 0, no: 0 }) },
        { ...value.answers, rank: { type: "score", score: 1.25, probabilities: [0, 0, 0] } },
      ]) {
        check({ ...value, answers }, semantics !== "categorical");
      }
    },
  );

  it("distinguishes undeclared question support from an explicitly unsupported kind", () => {
    const capabilities: Parameters<typeof validateDecisionResultV2>[2] = {
      protocol: "fixture-native",
      input: ["text"],
    };
    resultChecker(batch, capabilities)(result());
    resultChecker(batch, {
      ...capabilities,
      questions: { boolean: { probabilities: "boolean", abstention: true } },
    })(result(), false);
  });

  it("rejects confidence reports when the route declares no confidence metric", () => {
    const capabilities: DecisionAnswerCapabilities = {
      confidence: "none",
    };
    const cases: { input: DecisionBatchV2; answers: Record<string, DecisionAnswerV2> }[] = [
      {
        input: batch,
        answers: {
          truth: { type: "boolean", answer: true },
          pick: { type: "choice", choice: "yes" },
          rank: { type: "score", score: 1.25 },
        },
      },
      {
        input: { ...listBatch, questions: { sort: { type: "sort" } } },
        answers: { sort: { type: "sort", order: ["b", "a"] } },
      },
    ];
    for (const { input, answers } of cases) {
      const value = { model: "fixture", answers };
      const check = resultChecker(input, capabilities);
      check(value);
      for (const [key, answer] of Object.entries(answers)) {
        if (answer.type === "boolean") {
          continue;
        }
        for (const confidence of [0.9, null]) {
          const reported = {
            ...value,
            answers: { ...answers, [key]: { ...answer, confidence } },
          };
          check(reported, false);
          resultChecker(input, { ...capabilities, confidence: "provider-specific" })(reported);
        }
      }
    }
  });

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
    const check = resultChecker(scaleBatch, capabilities);
    check(value);
    check({ ...value, usage: { costUsd: 0, units: { unit: "requests", amount: 1 } } });
    for (const answers of [
      { ...value.answers, truth: { type: "boolean", answer: null, probabilityTrue: 0 } },
      { ...value.answers, scale: { type: "score", score: 2.5, probabilities: [0, 0, 0, 0, 0] } },
      { ...value.answers, scale: { type: "score", score: 4.01 } },
    ]) {
      check({ ...value, answers }, false);
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
        tags: { type: "tags", tags: [tag("red", false), tag("blue", true)] },
      },
    };
    const check = resultChecker(listBatch, capabilities);
    check(value);
    for (const tags of [
      [tag("red", null), tag("blue", true)],
      [tag("red", false, 0), tag("blue", true)],
    ]) {
      check({ ...value, answers: { ...value.answers, tags: { type: "tags", tags } } }, false);
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
    expectResult(value);
    expectResult({ ...value, answers: { ...value.answers, truth: { type: "boolean" } } }, false);
  });
  it("preserves abstention, independent estimates, fractional scores and reported accounting without mutation", () => {
    const value = result();
    const before = structuredClone(value);
    expectResult(value);
    expect(value).toEqual(before);
    expect(value.answers.rank).not.toHaveProperty("probabilities");
    expectAnswers({ truth: { type: "boolean", probabilityTrue: 0.9 } });
    expectAnswers({
      pick: { ...choice("no", { yes: 0.9, no: 0.1 }), probability: 0.2, confidence: -2 },
    });
  });

  it("retains per-question errors alongside usable answers", () => {
    expectAnswers({
      pick: { type: "error", code: "provider-error", providerCode: "x".repeat(128) },
    });
    for (const error of [
      { type: "error", code: "bad" },
      { type: "error", code: ["provider-error"] },
      { type: "error", code: "provider-error", providerCode: "x".repeat(129) },
      { type: "error", code: "provider-error", metadata: {} },
    ]) {
      expectAnswers({ pick: error }, false);
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
      result({ truth: { type: "boolean", probabilityTrue: 0.5, confidence: 1 } }),
      result({ pick: choice("missing", { yes: 0, no: 0 }) }),
      result({ pick: choice(null, { yes: 0 }) }),
      result({ rank: { type: "score", score: 2.1 } }),
      result({ rank: { type: "score", score: 1, probabilities: [0.5, 0.5] } }),
    ]) {
      expectResult(invalid, false);
    }
    for (const n of [-0.01, 1.01, Number.NaN, Infinity]) {
      expectAnswers({ truth: { type: "boolean", probabilityTrue: n } }, false);
    }
  });

  it("validates native sort and tags identities without sorting or thresholding", () => {
    const value = listResult;
    const check = resultChecker(listBatch);
    expectState({ type: "list", items: [] }, true, {
      ...listBatch,
      questions: { sort: { type: "sort" } },
    });
    check(value);
    for (const order of [["a", "a"], ["a"], ["a", "c"], ["a", "b", "c"]]) {
      check({ ...value, answers: { ...value.answers, sort: { type: "sort", order } } }, false);
    }
    for (const tags of [
      [tag("red", true, 1)],
      [tag("red", true, 1), tag("red", false, 0)],
      [tag("red", true, 1), tag("other", null, 0)],
      [tag("red", true, 1), { id: "blue", probability: 0 }],
    ]) {
      check({ ...value, answers: { ...value.answers, tags: { type: "tags", tags } } }, false);
    }
  });

  it("rejects malformed caller shapes, unknown options, and sort without list evidence", () => {
    for (const invalid of [
      null,
      {},
      { ...batch, grounding: {} },
      { ...batch, state: "implicit" },
      { ...batch, state: { type: "json" } },
      { ...batch, state: listState("") },
      { ...batch, state: listState("a", "a") },
      { ...batch, questions: {} },
      { ...batch, questions: { q: { type: "sort" } } },
      { ...batch, questions: { q: { type: "boolean", instructions: 1 } } },
      { ...batch, questions: { q: { type: "boolean", criteria: { ignored: "x" } } } },
      { ...batch, questions: { q: { type: "tags", criteria: {} } } },
    ]) {
      expect(() => validateDecisionBatchV2(invalid)).toThrow(DecisionContractError);
      expect(Reflect.apply(validateDecisionResultV2, undefined, [invalid, result()])).toBe(false);
    }
    for (const value of [null, true, 1.5, "explicit json", [1, false], { value: 2 }]) {
      expectState({ type: "json", value });
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
      const input = { ...batch, state: { type: "json", value } };
      expect(() => validateDecisionBatchV2(input)).toThrow(DecisionContractError);
      expect(Reflect.apply(validateDecisionResultV2, undefined, [input, result()])).toBe(false);
      expectResult({ ...result(), metadata: value }, false);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(trap).not.toHaveBeenCalled();
    const shared = { value: 1 };
    expectState({ type: "json", value: { left: shared, right: shared } });
    expectState({ type: "json", value: Object.assign(Object.create(null), { value: 1 }) });
  });

  it("enforces finite JSON, question and list resource bounds", () => {
    const questions = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), { type: "boolean" }]));
    expect(validateDecisionBatchV2({ ...batch, questions: questions(400) })).toBe(true);
    expect(validateDecisionBatchV2({ ...batch, questions: questions(401) })).toBe(false);
    const list = (n: number) => ({
      type: "list",
      items: Array.from({ length: n }, (_, i) => ({ id: String(i), content: null })),
    });
    expectState(list(120), true, listBatch);
    expectState(list(121), false, listBatch);
    const empty: DecisionBatchV2 = {
      state: { type: "text", text: "" },
      questions: { q: { type: "boolean" } },
    };
    const remaining = 1_048_576 - Buffer.byteLength(JSON.stringify({ ...empty, state: "" }));
    expectState({ type: "text", text: "x".repeat(remaining) }, true, empty);
    expectState({ type: "text", text: "x".repeat(remaining + 1) }, false, empty);
    expectState({ type: "json", value: Array.from({ length: 20_001 }, () => null) }, false);
    let deep: unknown = null;
    for (let i = 0; i < 34; i++) {
      deep = { nested: deep };
    }
    expectState({ type: "json", value: deep }, false);
    expectResult({ ...result(), metadata: { text: "x".repeat(1_048_576) } }, false);
  });

  it("admits only canonical PNG/JPEG/WebP data URIs with a 4 MiB decoded ceiling", () => {
    for (const mime of ["png", "jpeg", "webp"]) {
      expectState({
        type: "image",
        dataUri: "data:image/" + mime + ";base64,AA==",
        text: "explicit",
      });
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
    expectState({ type: "image", dataUri, text: "x".repeat(1000) });
    const oversized = "data:image/png;base64," + Buffer.alloc(4 * 1_048_576 + 1).toString("base64");
    expectState({ type: "image", dataUri: oversized }, false);
    resultChecker({ ...batch, state: { type: "image", dataUri: oversized } })(result(), false);
    expectState({ type: "image", dataUri, text: "x".repeat(1_048_576) }, false);
  });
});
