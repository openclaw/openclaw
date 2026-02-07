import { describe, expect, it } from "vitest";
import { normalizeSlackToken, resolveSlackBotToken, resolveSlackAppToken } from "./token.js";

describe("normalizeSlackToken", () => {
  it("returns undefined for undefined", () => {
    expect(normalizeSlackToken(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(normalizeSlackToken("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only", () => {
    expect(normalizeSlackToken("   ")).toBeUndefined();
  });

  it("trims and returns valid token", () => {
    expect(normalizeSlackToken("  xoxb-123  ")).toBe("xoxb-123");
  });

  it("returns token as-is when already trimmed", () => {
    expect(normalizeSlackToken("xoxb-abc")).toBe("xoxb-abc");
  });
});

describe("resolveSlackBotToken", () => {
  it("delegates to normalizeSlackToken", () => {
    expect(resolveSlackBotToken("  tok  ")).toBe("tok");
    expect(resolveSlackBotToken(undefined)).toBeUndefined();
  });
});

describe("resolveSlackAppToken", () => {
  it("delegates to normalizeSlackToken", () => {
    expect(resolveSlackAppToken("  tok  ")).toBe("tok");
    expect(resolveSlackAppToken("")).toBeUndefined();
  });
});
