import { describe, expect, it } from "vitest";
import {
  resolveAgentModelToolValue,
  resolveAgentModelPrimaryValue,
  resolveAgentModelFallbackValues,
} from "./model-input.js";

describe("resolveAgentModelToolValue", () => {
  it("returns undefined for string config", () => {
    expect(resolveAgentModelToolValue("anthropic/claude-sonnet-4-20250514")).toBeUndefined();
  });

  it("returns undefined for undefined config", () => {
    expect(resolveAgentModelToolValue(undefined)).toBeUndefined();
  });

  it("returns undefined when tool is not set", () => {
    expect(resolveAgentModelToolValue({ primary: "ollama/qwen2.5-7b" })).toBeUndefined();
  });

  it("returns tool model when configured", () => {
    expect(
      resolveAgentModelToolValue({
        primary: "ollama/qwen2.5-7b",
        tool: "anthropic/claude-sonnet-4-20250514",
      }),
    ).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("returns undefined for empty string tool", () => {
    expect(
      resolveAgentModelToolValue({
        primary: "ollama/qwen2.5-7b",
        tool: "",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for whitespace-only tool", () => {
    expect(
      resolveAgentModelToolValue({
        primary: "ollama/qwen2.5-7b",
        tool: "   ",
      }),
    ).toBeUndefined();
  });

  it("trims whitespace from tool value", () => {
    expect(
      resolveAgentModelToolValue({
        primary: "ollama/qwen2.5-7b",
        tool: "  anthropic/claude-sonnet-4-20250514  ",
      }),
    ).toBe("anthropic/claude-sonnet-4-20250514");
  });

  it("coexists with primary and fallbacks", () => {
    const config = {
      primary: "ollama/qwen2.5-7b",
      tool: "anthropic/claude-sonnet-4-20250514",
      fallbacks: ["openai/gpt-4o"],
    };
    expect(resolveAgentModelToolValue(config)).toBe("anthropic/claude-sonnet-4-20250514");
    expect(resolveAgentModelPrimaryValue(config)).toBe("ollama/qwen2.5-7b");
    expect(resolveAgentModelFallbackValues(config)).toEqual(["openai/gpt-4o"]);
  });
});
