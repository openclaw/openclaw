import { describe, expect, it } from "vitest";
import { sanitizeChatSendMessageInput } from "./chat.js";

describe("sanitizeChatSendMessageInput", () => {
  it("rejects null bytes", () => {
    expect(sanitizeChatSendMessageInput("before\u0000after")).toEqual({
      ok: false,
      error: "message must not contain null bytes",
    });
  });

  it("strips unsafe control characters while preserving tab/newline/carriage return", () => {
    const result = sanitizeChatSendMessageInput("a\u0001b\tc\nd\re\u0007f\u007f");
    expect(result).toEqual({ ok: true, message: "ab\tc\nd\ref" });
  });

  it("normalizes unicode to NFC", () => {
    expect(sanitizeChatSendMessageInput("Cafe\u0301")).toEqual({ ok: true, message: "Café" });
  });
});
