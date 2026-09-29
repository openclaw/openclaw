import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMAGE_CHAT_SEND_TIMEOUT_MS,
  resolveChatSendTimeoutOverrideMs,
} from "./chat-send-timeout.js";

describe("resolveChatSendTimeoutOverrideMs", () => {
  it("gives an image turn five minutes by default", () => {
    expect(resolveChatSendTimeoutOverrideMs({ hasImageAttachment: true })).toBe(
      DEFAULT_IMAGE_CHAT_SEND_TIMEOUT_MS,
    );
  });

  it("does not change the default budget for a text turn", () => {
    expect(resolveChatSendTimeoutOverrideMs({ hasImageAttachment: false })).toBeUndefined();
  });

  it.each([0, 45_000, 10 * 60_000])(
    "preserves explicit timeout %i ms, including intentional no-timeout",
    (requestedTimeoutMs) => {
      expect(
        resolveChatSendTimeoutOverrideMs({ hasImageAttachment: true, requestedTimeoutMs }),
      ).toBe(requestedTimeoutMs);
    },
  );
});
