import { describe, expect, it } from "vitest";
import { validateApiKeyInput } from "./auth-choice.api-key.js";
import { validateAnthropicSetupToken } from "./auth-token.js";

describe("auth-choice.api-key", () => {
  describe("validateApiKeyInput", () => {
    it("rejects empty input", () => {
      expect(validateApiKeyInput("")).toBe("Required");
      expect(validateApiKeyInput("   ")).toBe("Required");
    });

    it("accepts regular API keys", () => {
      expect(validateApiKeyInput("sk-ant-api03-abc123")).toBeUndefined();
      expect(validateApiKeyInput("sk-proj-123456")).toBeUndefined();
      expect(validateApiKeyInput("any-non-empty-string")).toBeUndefined();
    });

    it("rejects setup-tokens with helpful message", () => {
      const result = validateApiKeyInput("sk-ant-oat01-" + "x".repeat(80));
      expect(result).toContain("setup-token");
      expect(result).toContain("Anthropic token");
    });

    it("handles shell-style assignments", () => {
      expect(validateApiKeyInput('ANTHROPIC_API_KEY="sk-ant-api03-test"')).toBeUndefined();
      expect(validateApiKeyInput("export KEY=sk-ant-api03-test")).toBeUndefined();
    });
  });

  describe("validateAnthropicSetupToken", () => {
    it("rejects empty input", () => {
      expect(validateAnthropicSetupToken("")).toBe("Required");
      expect(validateAnthropicSetupToken("   ")).toBe("Required");
    });

    it("accepts valid setup-tokens", () => {
      const validToken = "sk-ant-oat01-" + "x".repeat(80);
      expect(validateAnthropicSetupToken(validToken)).toBeUndefined();
    });

    it("rejects API keys with helpful message", () => {
      const result = validateAnthropicSetupToken("sk-ant-api03-test123456");
      expect(result).toContain("API key");
      expect(result).toContain("Anthropic API key");
    });

    it("rejects tokens with wrong prefix", () => {
      const result = validateAnthropicSetupToken("sk-proj-123456");
      expect(result).toContain("sk-ant-oat01-");
    });

    it("rejects tokens that are too short", () => {
      const result = validateAnthropicSetupToken("sk-ant-oat01-short");
      expect(result).toContain("too short");
    });
  });
});
