import { describe, expect, it } from "vitest";
import { validateChatSendParams, validateSessionsSendParams } from "../protocol/index.js";
import { normalizeOptionalChatExtraSystemPrompt } from "./chat.js";

describe("normalizeOptionalChatExtraSystemPrompt", () => {
  it("returns undefined for nullish, non-string, whitespace-only", () => {
    expect(normalizeOptionalChatExtraSystemPrompt(undefined)).toBeUndefined();
    expect(normalizeOptionalChatExtraSystemPrompt(null)).toBeUndefined();
    expect(normalizeOptionalChatExtraSystemPrompt(1)).toBeUndefined();
    expect(normalizeOptionalChatExtraSystemPrompt("   \t  ")).toBeUndefined();
  });

  it("trims NFC text", () => {
    expect(normalizeOptionalChatExtraSystemPrompt("  hello ")).toBe("hello");
  });

  it("rejects embedded null bytes", () => {
    expect(normalizeOptionalChatExtraSystemPrompt("a\u0000b")).toBeUndefined();
  });

  it("caps length at 65535", () => {
    const huge = "x".repeat(70_000);
    const out = normalizeOptionalChatExtraSystemPrompt(huge);
    expect(out?.length).toBe(65_535);
    expect(out?.at(-1)).toBe("x");
  });
});

describe("ChatSendParamsSchema extraSystemPrompt", () => {
  it("accepts optional extraSystemPrompt within maxLength", () => {
    const ok = validateChatSendParams({
      sessionKey: "main",
      message: "hi",
      idempotencyKey: "idem-1",
      extraSystemPrompt: "trusted operator context",
    });
    expect(ok).toBe(true);
  });

  it("rejects extraSystemPrompt over maxLength", () => {
    const ok = validateChatSendParams({
      sessionKey: "main",
      message: "hi",
      idempotencyKey: "idem-2",
      extraSystemPrompt: "x".repeat(65_536),
    });
    expect(ok).toBe(false);
  });
});

describe("SessionsSendParamsSchema extraSystemPrompt", () => {
  it("accepts optional extraSystemPrompt", () => {
    const ok = validateSessionsSendParams({
      key: "main",
      message: "hi",
      extraSystemPrompt: "ctx",
    });
    expect(ok).toBe(true);
  });
});
