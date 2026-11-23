import { describe, expect, it } from "vitest";
import { createTypingCallbacks } from "../../channels/typing.js";
import { createReplyDispatcherWithTyping } from "./reply-dispatcher.js";

describe("reply dispatcher typing revive", () => {
  it("hands the channel successor opener to get-reply", () => {
    const callbacks = createTypingCallbacks({
      start: async () => {},
      onStartError: () => {},
      maxDurationMs: 0,
    });
    const { replyOptions } = createReplyDispatcherWithTyping({
      typingCallbacks: callbacks,
      deliver: async () => undefined,
    });

    expect(replyOptions.onTypingRevive).toBe(callbacks.beginNextLifecycle);
  });
});
