import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { expect, it } from "vitest";
import { supportsDecisionInput } from "./capabilities.js";
import type { DecisionBatchV2 } from "./types-v2.js";

const capability: ModelDecisionCapabilities = { protocol: "fixture", input: ["text", "image"] };
const text: DecisionBatchV2 = {
  state: { type: "text", text: "explicit evidence" },
  questions: { answer: { type: "boolean" } },
};
const image: DecisionBatchV2 = {
  ...text,
  state: { type: "image", dataUri: "data:image/png;base64,AQI=" },
};
const list: DecisionBatchV2 = {
  state: {
    type: "list",
    items: [
      { id: "a", content: "first" },
      { id: "b", content: "second" },
    ],
  },
  questions: { order: { type: "sort" } },
};

it("distinguishes missing capabilities, undeclared question kinds, and explicit exclusions", () => {
  expect(supportsDecisionInput(undefined, text, undefined)).toBe(false);
  expect(supportsDecisionInput({ input: ["text", "image"] }, text, undefined)).toBe(true);
  expect(
    supportsDecisionInput(
      { ...capability, questions: { choice: { probabilities: "none", abstention: false } } },
      text,
      undefined,
    ),
  ).toBe(false);
  expect(supportsDecisionInput({ ...capability, input: ["text"] }, image, undefined)).toBe(false);
  expect(supportsDecisionInput({ ...capability, input: ["text"] }, list, undefined)).toBe(true);
  expect(supportsDecisionInput({ ...capability, input: ["image"] }, list, undefined)).toBe(false);
});

it("keeps omitted reasoning distinct from an explicit mode and scopes reasoning by question", () => {
  for (const mode of ["auto", "off", "on"] as const) {
    expect(supportsDecisionInput(capability, text, mode)).toBe(false);
  }
  const reasoning: ModelDecisionCapabilities = {
    ...capability,
    reasoning: { modes: ["on", "off"], questionTypes: ["boolean"] },
  };
  expect(supportsDecisionInput(reasoning, text, "on")).toBe(true);
  expect(supportsDecisionInput(reasoning, list, "on")).toBe(false);
  expect(supportsDecisionInput(reasoning, list, "off")).toBe(true);
  expect(supportsDecisionInput(reasoning, list, undefined)).toBe(true);
});

const optionBatches: { name: string; batch: DecisionBatchV2 }[] = [
  {
    name: "choice",
    batch: {
      ...text,
      questions: { pick: { type: "choice", criteria: { a: "first", b: "second" } } },
    },
  },
  {
    name: "score",
    batch: { ...text, questions: { score: { type: "score", criteria: ["low", "high"] } } },
  },
  {
    name: "tags",
    batch: {
      ...text,
      questions: { tags: { type: "tags", criteria: { a: "first", b: "second" } } },
    },
  },
  { name: "sort", batch: list },
];
it.each(optionBatches)("enforces declared option bounds for $name", ({ name, batch }) => {
  const kind = { probabilities: "none" as const, abstention: false, minOptions: 2, maxOptions: 2 };
  expect(
    supportsDecisionInput({ ...capability, questions: { [name]: kind } }, batch, undefined),
  ).toBe(true);
  expect(
    supportsDecisionInput(
      { ...capability, questions: { [name]: { ...kind, minOptions: 3, maxOptions: 3 } } },
      batch,
      undefined,
    ),
  ).toBe(false);
  expect(
    supportsDecisionInput(
      { ...capability, questions: { [name]: { ...kind, minOptions: 1, maxOptions: 1 } } },
      batch,
      undefined,
    ),
  ).toBe(false);
});

it("enforces image-specific option limits and total question limits", () => {
  const choice = optionBatches[0]!.batch;
  const choices: ModelDecisionCapabilities = {
    ...capability,
    questions: {
      choice: { probabilities: "none", abstention: false, maxOptions: 2, maxImageOptions: 1 },
    },
  };
  expect(supportsDecisionInput(choices, choice, undefined)).toBe(true);
  expect(supportsDecisionInput(choices, { ...choice, state: image.state }, undefined)).toBe(false);
  const one: ModelDecisionCapabilities = { ...capability, limits: { maxQuestions: 1 } };
  expect(supportsDecisionInput(one, text, undefined)).toBe(true);
  expect(
    supportsDecisionInput(
      one,
      { ...text, questions: { a: { type: "boolean" }, b: { type: "boolean" } } },
      undefined,
    ),
  ).toBe(false);
});

it("requires both Boolean criteria only when the route declares that requirement", () => {
  const criteria: ModelDecisionCapabilities = {
    ...capability,
    questions: { boolean: { probabilities: "boolean", abstention: false, requiresCriteria: true } },
  };
  expect(supportsDecisionInput(criteria, text, undefined)).toBe(false);
  const partial: DecisionBatchV2 = {
    ...text,
    questions: { answer: { type: "boolean", criteria: { true: "yes" } } },
  };
  expect(supportsDecisionInput(criteria, partial, undefined)).toBe(false);
  const both: DecisionBatchV2 = {
    ...text,
    questions: { answer: { type: "boolean", criteria: { true: "", false: "no" } } },
  };
  expect(supportsDecisionInput(criteria, both, undefined)).toBe(true);
});

it("checks declared image MIME types and decoded byte limits", () => {
  const limits: ModelDecisionCapabilities = {
    ...capability,
    limits: { image: { maxBytes: 2, mimeTypes: ["image/png"], remoteUrls: false } },
  };
  expect(supportsDecisionInput(limits, image, undefined)).toBe(true);
  expect(
    supportsDecisionInput(
      limits,
      { ...image, state: { type: "image", dataUri: "data:image/png;base64,AQID" } },
      undefined,
    ),
  ).toBe(false);
  expect(
    supportsDecisionInput(
      limits,
      { ...image, state: { type: "image", dataUri: "data:image/jpeg;base64,AQI=" } },
      undefined,
    ),
  ).toBe(false);
});
