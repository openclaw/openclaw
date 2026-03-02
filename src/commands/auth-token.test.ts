import { describe, expect, it } from "vitest";
import {
  normalizeSetupToken,
  validateAnthropicSetupToken,
  ANTHROPIC_SETUP_TOKEN_MIN_LENGTH,
  ANTHROPIC_SETUP_TOKEN_PREFIX,
} from "./auth-token.js";

// Fake token with realistic structure (prefix + random base64-like chars, >80 chars)
const FAKE_TOKEN_PART1 = "sk-ant-oat01-aaaBBBcccDDDeee-FFFgggHHHiiiJJJkkkLLLmmmNNNooo-PPPqqqRRRsss";
const FAKE_TOKEN_PART2 = "TTTuuuVVVwwwXXXyyyZZZ123456";
const FAKE_TOKEN = FAKE_TOKEN_PART1 + FAKE_TOKEN_PART2;

describe("normalizeSetupToken", () => {
  it("strips newlines from pasted tokens", () => {
    const pasted = FAKE_TOKEN_PART1 + "\n" + FAKE_TOKEN_PART2;
    expect(normalizeSetupToken(pasted)).toBe(FAKE_TOKEN);
  });

  it("strips carriage-return + newline", () => {
    const pasted = FAKE_TOKEN_PART1 + "\r\n" + FAKE_TOKEN_PART2;
    expect(normalizeSetupToken(pasted)).toBe(FAKE_TOKEN);
  });

  it("strips leading and trailing whitespace", () => {
    expect(normalizeSetupToken(`  ${FAKE_TOKEN}  `)).toBe(FAKE_TOKEN);
  });

  it("passes through clean tokens unchanged", () => {
    expect(normalizeSetupToken(FAKE_TOKEN)).toBe(FAKE_TOKEN);
  });

  it("returns empty string for empty input", () => {
    expect(normalizeSetupToken("")).toBe("");
    expect(normalizeSetupToken("  \n  ")).toBe("");
  });
});

describe("validateAnthropicSetupToken", () => {
  it("accepts a valid token", () => {
    expect(FAKE_TOKEN.length).toBeGreaterThanOrEqual(ANTHROPIC_SETUP_TOKEN_MIN_LENGTH);
    expect(validateAnthropicSetupToken(FAKE_TOKEN)).toBeUndefined();
  });

  it("accepts a valid token with embedded newlines", () => {
    const withNewline = FAKE_TOKEN_PART1 + "\n" + FAKE_TOKEN_PART2;
    expect(validateAnthropicSetupToken(withNewline)).toBeUndefined();
  });

  it("rejects empty input", () => {
    expect(validateAnthropicSetupToken("")).toBe("Required");
  });

  it("rejects wrong prefix", () => {
    expect(validateAnthropicSetupToken("sk-ant-api03-" + "x".repeat(80))).toMatch(/Expected token/);
  });

  it("rejects tokens shorter than minimum length", () => {
    const short = ANTHROPIC_SETUP_TOKEN_PREFIX + "too-short";
    expect(validateAnthropicSetupToken(short)).toMatch(/too short/);
  });

  it("handles token split across lines during paste", () => {
    // Simulates terminal paste where a long token wraps and introduces a newline
    const withNewline = FAKE_TOKEN_PART1 + "\n" + FAKE_TOKEN_PART2;
    // Validation should accept the full token after normalizing away the newline
    expect(validateAnthropicSetupToken(withNewline)).toBeUndefined();
    // Normalized form should be longer than the minimum
    expect(normalizeSetupToken(withNewline).length).toBeGreaterThan(
      ANTHROPIC_SETUP_TOKEN_MIN_LENGTH,
    );
  });
});
