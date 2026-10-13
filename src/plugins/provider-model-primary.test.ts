import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyPrimaryModel } from "./provider-model-primary.js";

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type PrimaryCase = {
  name: string;
  defaults: Defaults;
  model: string;
  options?: Parameters<typeof applyPrimaryModel>[2];
  expectedModel: Defaults["model"];
  expectedModels: Defaults["models"];
};

const cases: PrimaryCase[] = [
  {
    name: "normalizes retired Gemini allowlist keys and fallbacks before writing the primary",
    defaults: {
      model: { primary: "openai/gpt-5.5", fallbacks: ["google/gemini-3-pro-preview"] },
      models: {
        "google/gemini-3-pro-preview": { alias: "gemini", params: { thinking: "high" } },
      },
    },
    model: "google/gemini-3-pro-preview",
    expectedModel: {
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    },
    expectedModels: {
      "google/gemini-3.1-pro-preview": { alias: "gemini", params: { thinking: "high" } },
    },
  },
  {
    name: "normalizes a preserved retired Google Gemini primary",
    defaults: { model: { primary: "google/gemini-3-pro-preview" } },
    model: "openrouter/auto",
    options: { preserveExistingPrimary: true },
    expectedModel: { primary: "google/gemini-3.1-pro-preview" },
    expectedModels: { "openrouter/auto": {} },
  },
  {
    name: "preserves an existing primary and keeps fallbacks",
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.4"] },
    },
    model: "openrouter/auto",
    options: { preserveExistingPrimary: true },
    expectedModel: {
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.4"],
    },
    expectedModels: { "openrouter/auto": {} },
  },
  {
    name: "normalizes retired Google Gemini default models before writing config",
    defaults: { models: { "anthropic/claude-sonnet-4-6": {} } },
    model: "google/gemini-3-pro-preview",
    expectedModel: { primary: "google/gemini-3.1-pro-preview" },
    expectedModels: {
      "anthropic/claude-sonnet-4-6": {},
      "google/gemini-3.1-pro-preview": {},
    },
  },
];

describe("applyPrimaryModel", () => {
  it.each(cases)("$name", ({ defaults, model, options, expectedModel, expectedModels }) => {
    const next = applyPrimaryModel({ agents: { defaults } }, model, options);
    expect(next.agents?.defaults?.model).toEqual(expectedModel);
    expect(next.agents?.defaults?.models).toEqual(expectedModels);
  });
});
