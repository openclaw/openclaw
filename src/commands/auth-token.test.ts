import { describe, expect, it } from "vitest";
import { ANTHROPIC_SETUP_TOKEN_PREFIX, validateAnthropicSetupToken } from "./auth-token.js";

describe("validateAnthropicSetupToken", () => {
  it("accepts legacy Anthropic setup tokens", () => {
    expect(
      validateAnthropicSetupToken(`${ANTHROPIC_SETUP_TOKEN_PREFIX}${"x".repeat(100)}`),
    ).toBeUndefined();
  });

  it("accepts newer setup token prefixes", () => {
    expect(validateAnthropicSetupToken(`bb${"x".repeat(100)}`)).toBeUndefined();
  });

  it("rejects short setup tokens", () => {
    expect(validateAnthropicSetupToken(`bb${"x".repeat(10)}`)).toBe(
      "Token looks too short; paste the full setup-token",
    );
  });
});
