import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_REFRESH_TOKEN_PREFIX,
  ANTHROPIC_SETUP_TOKEN_MIN_LENGTH,
  ANTHROPIC_SETUP_TOKEN_PREFIX,
  tryParseClaudeCredentials,
  validateAnthropicRefreshToken,
  validateAnthropicSetupToken,
} from "./auth-token.js";

// Realistic-length tokens for testing
const VALID_ACCESS_TOKEN = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"a".repeat(ANTHROPIC_SETUP_TOKEN_MIN_LENGTH)}`;
const VALID_REFRESH_TOKEN = `${ANTHROPIC_REFRESH_TOKEN_PREFIX}${"b".repeat(ANTHROPIC_SETUP_TOKEN_MIN_LENGTH)}`;

function makeCredentialsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: VALID_ACCESS_TOKEN,
      refreshToken: VALID_REFRESH_TOKEN,
      expiresAt: Date.now() + 3600_000,
      ...overrides,
    },
  });
}

describe("validateAnthropicRefreshToken", () => {
  it("accepts empty string (optional)", () => {
    expect(validateAnthropicRefreshToken("")).toBeUndefined();
  });

  it("accepts whitespace-only (optional)", () => {
    expect(validateAnthropicRefreshToken("   ")).toBeUndefined();
  });

  it("accepts valid refresh token", () => {
    expect(validateAnthropicRefreshToken(VALID_REFRESH_TOKEN)).toBeUndefined();
  });

  it("accepts valid refresh token with surrounding whitespace", () => {
    expect(validateAnthropicRefreshToken(`  ${VALID_REFRESH_TOKEN}  `)).toBeUndefined();
  });

  it("rejects token with wrong prefix", () => {
    const result = validateAnthropicRefreshToken("sk-ant-oat01-wrong-prefix");
    expect(result).toContain(ANTHROPIC_REFRESH_TOKEN_PREFIX);
  });

  it("rejects token that is too short", () => {
    const result = validateAnthropicRefreshToken(`${ANTHROPIC_REFRESH_TOKEN_PREFIX}short`);
    expect(result).toContain("too short");
  });
});

describe("tryParseClaudeCredentials", () => {
  it("parses full credentials JSON with all fields", () => {
    const result = tryParseClaudeCredentials(makeCredentialsJson());
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(VALID_ACCESS_TOKEN);
    expect(result!.refreshToken).toBe(VALID_REFRESH_TOKEN);
    expect(typeof result!.expiresAt).toBe("number");
  });

  it("parses JSON with access token only (no refresh token)", () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: VALID_ACCESS_TOKEN },
    });
    const result = tryParseClaudeCredentials(json);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(VALID_ACCESS_TOKEN);
    expect(result!.refreshToken).toBeNull();
    expect(result!.expiresAt).toBeNull();
  });

  it("parses JSON with access token and invalid refresh token prefix", () => {
    const json = makeCredentialsJson({ refreshToken: "not-a-valid-prefix" });
    const result = tryParseClaudeCredentials(json);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(VALID_ACCESS_TOKEN);
    expect(result!.refreshToken).toBeNull();
  });

  it("parses JSON with access token and non-string expiresAt", () => {
    const json = makeCredentialsJson({ expiresAt: "not-a-number" });
    const result = tryParseClaudeCredentials(json);
    expect(result).not.toBeNull();
    expect(result!.accessToken).toBe(VALID_ACCESS_TOKEN);
    expect(result!.expiresAt).toBeNull();
  });

  it("returns null for non-JSON input", () => {
    expect(tryParseClaudeCredentials(VALID_ACCESS_TOKEN)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(tryParseClaudeCredentials("")).toBeNull();
  });

  it("returns null for JSON without claudeAiOauth key", () => {
    expect(tryParseClaudeCredentials(JSON.stringify({ other: "data" }))).toBeNull();
  });

  it("returns null when accessToken has wrong prefix", () => {
    const json = makeCredentialsJson({ accessToken: "wrong-prefix-token" });
    expect(tryParseClaudeCredentials(json)).toBeNull();
  });

  it("returns null when accessToken is missing", () => {
    const json = JSON.stringify({
      claudeAiOauth: {
        refreshToken: VALID_REFRESH_TOKEN,
        expiresAt: Date.now(),
      },
    });
    expect(tryParseClaudeCredentials(json)).toBeNull();
  });

  it("handles JSON with surrounding whitespace", () => {
    const result = tryParseClaudeCredentials(`  ${makeCredentialsJson()}  `);
    expect(result).not.toBeNull();
  });
});

describe("validateAnthropicSetupToken", () => {
  it("accepts valid setup token", () => {
    expect(validateAnthropicSetupToken(VALID_ACCESS_TOKEN)).toBeUndefined();
  });

  it("accepts full JSON credentials blob", () => {
    expect(validateAnthropicSetupToken(makeCredentialsJson())).toBeUndefined();
  });

  it("accepts JSON with access token only (no refresh token)", () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: VALID_ACCESS_TOKEN },
    });
    expect(validateAnthropicSetupToken(json)).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(validateAnthropicSetupToken("")).toBe("Required");
  });

  it("rejects token with wrong prefix", () => {
    const result = validateAnthropicSetupToken("wrong-prefix-token");
    expect(result).toContain(ANTHROPIC_SETUP_TOKEN_PREFIX);
  });

  it("rejects token that is too short", () => {
    const result = validateAnthropicSetupToken(`${ANTHROPIC_SETUP_TOKEN_PREFIX}short`);
    expect(result).toContain("too short");
  });

  it("rejects invalid JSON starting with {", () => {
    const result = validateAnthropicSetupToken("{invalid json}");
    expect(result).toContain("Invalid JSON");
  });

  it("rejects JSON without claudeAiOauth.accessToken", () => {
    const result = validateAnthropicSetupToken(JSON.stringify({ claudeAiOauth: {} }));
    expect(result).toContain("Invalid JSON");
  });

  it("rejects JSON with wrong accessToken prefix", () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: "wrong-prefix" },
    });
    const result = validateAnthropicSetupToken(json);
    expect(result).toContain("Invalid JSON");
  });
});
