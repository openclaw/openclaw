import { describe, expect, it } from "vitest";
import { parseTelegramReplyToMessageId, parseTelegramThreadId } from "./outbound-params.js";

describe("parseTelegramReplyToMessageId", () => {
  it("returns the integer for a valid positive integer string", () => {
    expect(parseTelegramReplyToMessageId("12345")).toBe(12345);
  });

  it("returns the integer for a negative integer string", () => {
    expect(parseTelegramReplyToMessageId("-99")).toBe(-99);
  });

  it("returns undefined for a UUID string (webchat replyToId)", () => {
    expect(parseTelegramReplyToMessageId("29873f86-9dd4-4b2a-a1e7-deadbeef0001")).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(parseTelegramReplyToMessageId(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseTelegramReplyToMessageId(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(parseTelegramReplyToMessageId("")).toBeUndefined();
  });

  it("returns undefined for a string with mixed digits and letters", () => {
    expect(parseTelegramReplyToMessageId("123abc")).toBeUndefined();
  });
});

describe("parseTelegramThreadId", () => {
  it("returns the integer for a valid positive integer string", () => {
    expect(parseTelegramThreadId("42")).toBe(42);
  });

  it("returns the integer for a number input", () => {
    expect(parseTelegramThreadId(7)).toBe(7);
  });

  it("extracts thread id from scoped format", () => {
    expect(parseTelegramThreadId("-100123:456")).toBe(456);
  });

  it("returns undefined for null", () => {
    expect(parseTelegramThreadId(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseTelegramThreadId(undefined)).toBeUndefined();
  });
});
