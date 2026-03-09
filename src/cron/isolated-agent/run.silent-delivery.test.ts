import { describe, expect, it } from "vitest";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { resolveSilentCronDeliveryText } from "./run.js";

describe("resolveSilentCronDeliveryText", () => {
  it("synthesizes NO_REPLY for silent cron completions without other delivery text", () => {
    expect(resolveSilentCronDeliveryText({ silentReply: true })).toBe(SILENT_REPLY_TOKEN);
  });

  it("does not synthesize NO_REPLY when a messaging tool already sent elsewhere", () => {
    expect(
      resolveSilentCronDeliveryText({
        silentReply: true,
        didSendViaMessagingTool: true,
      }),
    ).toBeUndefined();
  });

  it("does not override an existing synthesized reply", () => {
    expect(
      resolveSilentCronDeliveryText({
        silentReply: true,
        synthesizedText: "already have text",
      }),
    ).toBeUndefined();
  });
});
