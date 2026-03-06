import { describe, expect, it } from "vitest";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";

describe("parseTelegramReplyToMessageId", () => {
  it("parses a valid numeric id", () => {
    expect(parseTelegramReplyToMessageId("123")).toBe(123);
    expect(parseTelegramReplyToMessageId(" 456 ")).toBe(456);
  });

  it("returns undefined for non-numeric ids", () => {
    expect(parseTelegramReplyToMessageId("abc")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("123abc")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("12.3")).toBeUndefined();
  });

  it("returns undefined for empty or invalid numeric-like ids", () => {
    expect(parseTelegramReplyToMessageId("")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("   ")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("-12")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("0")).toBeUndefined();
    expect(parseTelegramReplyToMessageId(undefined)).toBeUndefined();
    expect(parseTelegramReplyToMessageId(null)).toBeUndefined();
  });
});

describe("parseTelegramThreadId", () => {
  it("keeps existing scoped thread id behavior", () => {
    expect(parseTelegramThreadId("-100123456:77")).toBe(77);
  });
});
