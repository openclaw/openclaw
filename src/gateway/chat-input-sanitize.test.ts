// Tests for chat input control character sanitization.
import { describe, expect, test } from "vitest";
import { sanitizeChatSendMessageInput } from "./chat-input-sanitize.js";

describe("sanitizeChatSendMessageInput", () => {
  test("strips disallowed control characters (NUL–BS, VT, FF, SO–US, DEL)", () => {
    // Build a string containing every disallowed control character except NUL (0).
    // NUL is covered by the separate reject-null-byte gate in sanitizeChatSendMessageInput.
    const disallowed = [
      ...Array.from({ length: 8 }, (_, i) => String.fromCodePoint(1 + i)), // 1–8
      String.fromCodePoint(11), // VT
      String.fromCodePoint(12), // FF
      ...Array.from({ length: 18 }, (_, i) => String.fromCodePoint(14 + i)), // 14–31
      String.fromCodePoint(127), // DEL
    ].join("");
    const allowed = "hello";
    const result = sanitizeChatSendMessageInput(disallowed + allowed + disallowed);
    expect(result).toEqual({ ok: true, message: allowed });
  });

  test("preserves tab, newline, and carriage return", () => {
    const result = sanitizeChatSendMessageInput("a\tb\nc\rd");
    expect(result).toEqual({ ok: true, message: "a\tb\nc\rd" });
  });

  test("preserves printable ASCII and Unicode characters", () => {
    const result = sanitizeChatSendMessageInput("Hello, 世界! ~`!@#$%^&*()_+-=[]{}|;:',.<>?/\"");
    expect(result).toEqual({
      ok: true,
      message: "Hello, 世界! ~`!@#$%^&*()_+-=[]{}|;:',.<>?/\"",
    });
  });

  test("rejects null byte via sanitizeChatSendMessageInput even when not in the regex range", () => {
    const result = sanitizeChatSendMessageInput("foo\u0000bar");
    expect(result).toEqual({ ok: false, error: "message must not contain null bytes" });
  });

  test("returns empty string when the message consists entirely of disallowed characters", () => {
    // Use a mix of disallowed control chars
    const result = sanitizeChatSendMessageInput("");
    expect(result).toEqual({ ok: true, message: "" });
  });

  test("returns the input unchanged when no disallowed characters are present", () => {
    const input = "plain text without any control chars";
    const result = sanitizeChatSendMessageInput(input);
    expect(result).toEqual({ ok: true, message: input });
  });

  test("strips DEL (127) which is the boundary between control and printable ASCII", () => {
    const result = sanitizeChatSendMessageInput("beforeafter");
    expect(result).toEqual({ ok: true, message: "beforeafter" });
  });

  test("preserves the full printable ASCII range (32–126)", () => {
    const printable = Array.from({ length: 95 }, (_, i) => String.fromCodePoint(32 + i)).join("");
    const result = sanitizeChatSendMessageInput(printable);
    expect(result).toEqual({ ok: true, message: printable });
  });
});
