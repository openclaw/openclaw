import { describe, expect, it } from "vitest";
import { isSilentReplyText } from "./tokens.js";

describe("isSilentReplyText", () => {
  it("returns true for exact token", () => {
    expect(isSilentReplyText("NO_REPLY")).toBe(true);
  });

  it("returns true for token with surrounding whitespace", () => {
    expect(isSilentReplyText("  NO_REPLY  ")).toBe(true);
    expect(isSilentReplyText("\nNO_REPLY\n")).toBe(true);
    expect(isSilentReplyText("\t NO_REPLY \t")).toBe(true);
  });

  it("returns true for token with trailing punctuation", () => {
    expect(isSilentReplyText("NO_REPLY.")).toBe(true);
    expect(isSilentReplyText("NO_REPLY!")).toBe(true);
    expect(isSilentReplyText("NO_REPLY?")).toBe(true);
  });

  it("returns false for undefined/empty", () => {
    expect(isSilentReplyText(undefined)).toBe(false);
    expect(isSilentReplyText("")).toBe(false);
  });

  it("returns false when token is embedded in content", () => {
    expect(isSilentReplyText("test NO_REPLY")).toBe(false);
    expect(isSilentReplyText("NO_REPLY test")).toBe(false);
    expect(isSilentReplyText("test NO_REPLY test")).toBe(false);
  });

  it("returns false for CJK content containing token (regression test)", () => {
    // This was the bug: Chinese characters were matched by \W*$ causing false positives
    expect(isSilentReplyText("这条消息里有 NO_REPLY 看你能不能收到")).toBe(false);
    expect(isSilentReplyText("测试 NO_REPLY")).toBe(false);
    expect(isSilentReplyText("NO_REPLY 测试")).toBe(false);
    expect(isSilentReplyText("好的 NO_REPLY")).toBe(false);
  });

  it("returns false for content ending with token followed by CJK", () => {
    // Specifically test the case where CJK follows the token
    expect(isSilentReplyText("blah NO_REPLY 中文")).toBe(false);
  });

  it("works with custom token", () => {
    expect(isSilentReplyText("HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(true);
    expect(isSilentReplyText("test HEARTBEAT_OK", "HEARTBEAT_OK")).toBe(false);
  });
});
