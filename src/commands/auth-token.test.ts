import { describe, expect, it } from "vitest";
import { validateAnthropicSetupToken } from "./auth-token.js";

describe("validateAnthropicSetupToken", () => {
  it("accepts legacy oat01 setup tokens", () => {
    const token = `sk-ant-oat01-${"x".repeat(80)}`;
    expect(validateAnthropicSetupToken(token)).toBeUndefined();
  });

  it("accepts newer anthropic setup token prefixes", () => {
    const token = `sk-ant-api02-${"x".repeat(80)}`;
    expect(validateAnthropicSetupToken(token)).toBeUndefined();
  });

  it("rejects non-anthropic tokens", () => {
    const token = `sk-proj-${"x".repeat(120)}`;
    expect(validateAnthropicSetupToken(token)).toBe("Expected token starting with sk-ant-");
  });
});
