import { describe, expect, it } from "vitest";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";

describe("parseTelegramReplyToMessageId", () => {
  it("parses positive numeric strings", () => {
    expect(parseTelegramReplyToMessageId("44")).toBe(44);
    expect(parseTelegramReplyToMessageId(" 55 ")).toBe(55);
  });

  it("returns undefined for empty or invalid values", () => {
    expect(parseTelegramReplyToMessageId(undefined)).toBeUndefined();
    expect(parseTelegramReplyToMessageId(null)).toBeUndefined();
    expect(parseTelegramReplyToMessageId("")).toBeUndefined();
    expect(parseTelegramReplyToMessageId(" ")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("0")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("-1")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("44abc")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("abc44")).toBeUndefined();
    expect(parseTelegramReplyToMessageId("4.4")).toBeUndefined();
  });
});

describe("parseTelegramThreadId", () => {
  it("parses plain and scoped thread ids", () => {
    expect(parseTelegramThreadId("55")).toBe(55);
    expect(parseTelegramThreadId("12345:99")).toBe(99);
  });

  it("returns undefined for malformed scoped ids", () => {
    expect(parseTelegramThreadId("12345:abc")).toBeUndefined();
    expect(parseTelegramThreadId("abc:99")).toBeUndefined();
    expect(parseTelegramThreadId("12345:")).toBeUndefined();
  });
});
