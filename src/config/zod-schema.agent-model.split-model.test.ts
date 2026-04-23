import { describe, expect, it } from "vitest";
import { AgentModelSchema } from "./zod-schema.agent-model.js";

describe("AgentModelSchema with tool field", () => {
  it("accepts config with tool model", () => {
    const result = AgentModelSchema.safeParse({
      primary: "ollama/qwen2.5-7b",
      tool: "anthropic/claude-sonnet-4-20250514",
    });
    expect(result.success).toBe(true);
  });

  it("accepts config with primary, tool, and fallbacks", () => {
    const result = AgentModelSchema.safeParse({
      primary: "ollama/qwen2.5-7b",
      tool: "anthropic/claude-sonnet-4-20250514",
      fallbacks: ["openai/gpt-4o"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts config with only tool", () => {
    const result = AgentModelSchema.safeParse({
      tool: "anthropic/claude-sonnet-4-20250514",
    });
    expect(result.success).toBe(true);
  });

  it("still accepts string-only config", () => {
    const result = AgentModelSchema.safeParse("anthropic/claude-sonnet-4-20250514");
    expect(result.success).toBe(true);
  });

  it("still accepts config without tool", () => {
    const result = AgentModelSchema.safeParse({
      primary: "ollama/qwen2.5-7b",
      fallbacks: ["openai/gpt-4o"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown fields in strict mode", () => {
    const result = AgentModelSchema.safeParse({
      primary: "ollama/qwen2.5-7b",
      tool: "anthropic/claude-sonnet-4-20250514",
      unknownField: "bad",
    });
    expect(result.success).toBe(false);
  });
});
