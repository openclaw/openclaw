import { describe, expect, it, vi } from "vitest";
import { createBlockReplyDeliveryHandler } from "./reply-delivery.js";
import { createMockTypingController } from "./test-helpers.js";

describe("createBlockReplyDeliveryHandler", () => {
  it("signals typing for media-only block replies", async () => {
    const typing = createMockTypingController();
    const onBlockReply = vi.fn(async () => {});

    const handler = createBlockReplyDeliveryHandler({
      onBlockReply,
      currentMessageId: "m1",
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: {
        mode: "message",
        shouldStartImmediately: false,
        shouldStartOnMessageStart: true,
        shouldStartOnText: true,
        shouldStartOnReasoning: false,
        signalRunStart: async () => {},
        signalMessageStart: async () => {},
        signalTextDelta: async (text?: string, mediaUrls?: string[]) => {
          await typing.startTypingOnText(text);
          if ((mediaUrls?.length ?? 0) > 0 && !text?.trim()) {
            await typing.startTypingLoop();
          }
        },
        signalReasoningDelta: async () => {},
        signalToolStart: async () => {},
      },
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
      directlySentBlockKeys: new Set<string>(),
    });

    await handler({ mediaUrls: ["https://example.com/image.png"] });

    expect(onBlockReply).toHaveBeenCalled();
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });
});
