import { describe, expect, it } from "vitest";
import { isFallbackModelActive } from "./fallback-state.js";

describe("isFallbackModelActive", () => {
  it("treats provider-prefixed default model as non-fallback when runtime matches", () => {
    expect(
      isFallbackModelActive({
        provider: "anthropic",
        model: "claude-opus-4-5",
        defaultProvider: "anthropic",
        defaultModel: "anthropic/claude-opus-4-5",
      }),
    ).toBe(false);
  });

  it("marks fallback active when provider differs", () => {
    expect(
      isFallbackModelActive({
        provider: "openai",
        model: "gpt-5.2",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-5",
      }),
    ).toBe(true);
  });
});
