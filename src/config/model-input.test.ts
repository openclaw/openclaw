import { describe, expect, it } from "vitest";
import { resolveAgentModelFallbackValues } from "./model-input.js";

describe("resolveAgentModelFallbackValues", () => {
  it("returns [] for string input", () => {
    expect(resolveAgentModelFallbackValues("anthropic/claude-opus-4-7")).toEqual([]);
  });

  it("returns fallbacks for object input with fallbacks", () => {
    expect(
      resolveAgentModelFallbackValues({
        primary: "anthropic/claude-opus-4-7",
        fallbacks: ["anthropic/claude-sonnet-4-7", "openai/gpt-5.5"],
      }),
    ).toEqual(["anthropic/claude-sonnet-4-7", "openai/gpt-5.5"]);
  });

  it("returns [] for undefined", () => {
    expect(resolveAgentModelFallbackValues(undefined)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(resolveAgentModelFallbackValues("")).toEqual([]);
  });

  it("returns [] for object without fallbacks", () => {
    expect(resolveAgentModelFallbackValues({ primary: "anthropic/claude-opus-4-7" })).toEqual([]);
  });
});
