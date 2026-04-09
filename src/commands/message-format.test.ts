import { describe, expect, it } from "vitest";
import { formatMessageCliText } from "./message-format.js";

describe("formatMessageCliText", () => {
  it("shows explicit blocked guidance for core send results", () => {
    const lines = formatMessageCliText({
      kind: "send",
      channel: "telegram",
      action: "send",
      to: "123456",
      handledBy: "core",
      payload: {},
      sendResult: {
        channel: "telegram",
        to: "123456",
        via: "direct",
        mediaUrl: null,
        blocked: true,
        blockedReason: "blocked by message_sending hook",
      },
      dryRun: false,
    });

    expect(lines).toEqual([
      "🚫 Send blocked via Telegram. blocked by message_sending hook",
    ]);
  });
});
