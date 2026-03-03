import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_SETUP_TOKEN_MIN_LENGTH,
  ANTHROPIC_SETUP_TOKEN_PREFIX,
  normalizeAnthropicSetupTokenInput,
  validateAnthropicSetupToken,
} from "./auth-token.js";

describe("normalizeAnthropicSetupTokenInput", () => {
  it("removes whitespace and line breaks from pasted setup-tokens", () => {
    const raw = `  ${ANTHROPIC_SETUP_TOKEN_PREFIX}abc \n\tdef\r\nghi  `;

    expect(normalizeAnthropicSetupTokenInput(raw)).toBe(`${ANTHROPIC_SETUP_TOKEN_PREFIX}abcdefghi`);
  });
});

describe("validateAnthropicSetupToken", () => {
  it("accepts wrapped tokens once whitespace is normalized", () => {
    const fullToken = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"a".repeat(ANTHROPIC_SETUP_TOKEN_MIN_LENGTH)}`;
    const wrappedToken = `${fullToken.slice(0, 45)}\n${fullToken.slice(45, 90)} \n\t${fullToken.slice(90)}`;

    expect(validateAnthropicSetupToken(wrappedToken)).toBeUndefined();
  });

  it("flags short tokens and mentions wrapping/truncation", () => {
    const shortToken = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"a".repeat(80)}`;
    const error = validateAnthropicSetupToken(shortToken);

    expect(error).toBeTruthy();
    expect(error).toContain("line wrapping");
  });
});
