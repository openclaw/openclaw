import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_KEY_PREFIX,
  ANTHROPIC_SETUP_TOKEN_MIN_LENGTH,
  ANTHROPIC_SETUP_TOKEN_PREFIX,
  ANTHROPIC_TOKEN_PREFIXES,
  buildTokenProfileId,
  DEFAULT_TOKEN_PROFILE_NAME,
  normalizeTokenProfileName,
  validateAnthropicSetupToken,
} from "./provider-auth-token.js";

describe("validateAnthropicSetupToken", () => {
  it("accepts a full sk-ant-oat01- setup token", () => {
    const token = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"a".repeat(80)}`;
    expect(validateAnthropicSetupToken(token)).toBeUndefined();
  });

  it("accepts a full sk-ant-api03- API key (#72121)", () => {
    const token = `${ANTHROPIC_API_KEY_PREFIX}${"a".repeat(80)}`;
    expect(validateAnthropicSetupToken(token)).toBeUndefined();
  });

  it("returns 'Required' for empty input", () => {
    expect(validateAnthropicSetupToken("")).toBe("Required");
    expect(validateAnthropicSetupToken("   ")).toBe("Required");
  });

  it("rejects tokens with neither known prefix and lists both in the error", () => {
    const result = validateAnthropicSetupToken("sk-other-foobar");
    expect(result).toBe(
      `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX} or ${ANTHROPIC_API_KEY_PREFIX}`,
    );
  });

  it("rejects setup-token-prefixed but too-short input with the setup-token hint", () => {
    expect(validateAnthropicSetupToken(`${ANTHROPIC_SETUP_TOKEN_PREFIX}short`)).toBe(
      "Token looks too short; paste the full setup-token",
    );
  });

  it("rejects api-key-prefixed but too-short input with the API-key hint (#72121)", () => {
    expect(validateAnthropicSetupToken(`${ANTHROPIC_API_KEY_PREFIX}short`)).toBe(
      "Token looks too short; paste the full API key",
    );
  });

  it("trims surrounding whitespace before validating", () => {
    const token = `   ${ANTHROPIC_API_KEY_PREFIX}${"a".repeat(80)}   `;
    expect(validateAnthropicSetupToken(token)).toBeUndefined();
  });

  it("ANTHROPIC_TOKEN_PREFIXES enumerates both supported prefixes", () => {
    expect(ANTHROPIC_TOKEN_PREFIXES).toEqual([
      ANTHROPIC_SETUP_TOKEN_PREFIX,
      ANTHROPIC_API_KEY_PREFIX,
    ]);
  });

  it("respects the shared minimum length boundary for both prefixes", () => {
    const oatTokenAtBoundary = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"a".repeat(
      ANTHROPIC_SETUP_TOKEN_MIN_LENGTH - ANTHROPIC_SETUP_TOKEN_PREFIX.length,
    )}`;
    const apiTokenAtBoundary = `${ANTHROPIC_API_KEY_PREFIX}${"a".repeat(
      ANTHROPIC_SETUP_TOKEN_MIN_LENGTH - ANTHROPIC_API_KEY_PREFIX.length,
    )}`;
    expect(validateAnthropicSetupToken(oatTokenAtBoundary)).toBeUndefined();
    expect(validateAnthropicSetupToken(apiTokenAtBoundary)).toBeUndefined();
  });
});

describe("normalizeTokenProfileName", () => {
  it("returns the default profile name when input is empty", () => {
    expect(normalizeTokenProfileName("")).toBe(DEFAULT_TOKEN_PROFILE_NAME);
    expect(normalizeTokenProfileName("   ")).toBe(DEFAULT_TOKEN_PROFILE_NAME);
  });

  it("slugifies arbitrary input", () => {
    expect(normalizeTokenProfileName("My Profile!")).toBe("my-profile");
  });
});

describe("buildTokenProfileId", () => {
  it("composes provider and normalized name", () => {
    expect(buildTokenProfileId({ provider: "anthropic", name: "Default" })).toBe(
      "anthropic:default",
    );
  });
});
