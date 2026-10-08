import { describe, expect, it } from "vitest";
import { ModelsConfigSchema } from "./zod-schema.core.js";

describe("configured decision provider schema", () => {
  const decisionProvider = {
    type: "decision",
    decisionProvider: "typesafe",
    baseUrl: "https://decision.example.test",
    apiKey: { source: "env", provider: "default", id: "DECISION_API_KEY" },
    models: [{ id: "classifier", name: "Classifier" }],
  };

  it("accepts a decision endpoint and protected key without chat API metadata", () => {
    const parsed = ModelsConfigSchema.parse({ providers: { judge: decisionProvider } });
    expect(parsed?.providers?.judge).toEqual(decisionProvider);
  });

  it.each([
    { decisionProvider: undefined },
    { decisionProvider: "  " },
    { decisionProvider: "typesafe/model" },
    { baseUrl: undefined },
    { models: [] },
    { api: "openai-completions" },
    { localService: { command: "server" } },
    { request: { allowPrivateNetwork: true } },
    { models: [{ id: "classifier", name: "Classifier", baseUrl: "https://other.example.test" }] },
  ])("rejects incomplete or ignored decision settings: %j", (override) => {
    expect(
      ModelsConfigSchema.safeParse({ providers: { judge: { ...decisionProvider, ...override } } })
        .success,
    ).toBe(false);
  });

  it("requires endpoint and models even when a decision entry uses a bundled provider ID", () => {
    expect(
      ModelsConfigSchema.safeParse({
        providers: { openai: { type: "decision", decisionProvider: "typesafe" } },
      }).success,
    ).toBe(false);
  });

  it.each([undefined, "chat"])("rejects a decision adapter on chat providers: %j", (type) => {
    expect(
      ModelsConfigSchema.safeParse({ providers: { judge: { ...decisionProvider, type } } }).success,
    ).toBe(false);
  });
});
