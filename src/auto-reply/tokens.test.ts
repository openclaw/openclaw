import { describe, it, expect } from "vitest";
import { isSilentReplyText } from "./tokens.js";

describe("isSilentReplyText", () => {
  it("matches exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("matches token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
  });

  it("matches token with ASCII annotation", () => {
    expect(isSilentReplyText("NO_REPLY -- nope")).toBe(true);
  });

  it("matches token preceded by ASCII punctuation", () => {
    expect(isSilentReplyText("interject.NO_REPLY")).toBe(true);
  });

  it("matches token with ASCII reason in parens", () => {
    expect(isSilentReplyText("NO_REPLY -- (why am I here?)")).toBe(true);
  });

  it("rejects undefined", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isSilentReplyText("")).toBe(false);
  });

  it("does not match token followed by CJK text", () => {
    expect(isSilentReplyText("NO_REPLY 这是中文消息")).toBe(false);
  });

  it("does not match token preceded by CJK text", () => {
    expect(isSilentReplyText("中文消息 NO_REPLY")).toBe(false);
  });

  it("does not match token surrounded by CJK text", () => {
    expect(isSilentReplyText("中文NO_REPLY消息")).toBe(false);
  });

  it("does not match token as substring", () => {
    expect(isSilentReplyText("NO_REPLY_EXTRA")).toBe(false);
  });

  it("works with custom token", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyText("HEARTBEAT_OK 还有中文", "HEARTBEAT_OK")).toBe(false);
  });
});
