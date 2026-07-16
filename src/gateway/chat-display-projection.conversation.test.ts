import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

function conversationMirror(status: "delivered" | "pending") {
  return {
    role: "assistant",
    content: [{ type: "text", text: status }],
    provider: "openclaw",
    model: "delivery-mirror",
    openclawDeliveryMirror: {
      kind: "conversation-send",
      status,
      channel: "reef",
      conversationRef: "conv_0123456789abcdef0123456789abcdef",
    },
  };
}

describe("conversation delivery display projection", () => {
  it("hides durable pending intents while retaining delivered sends", () => {
    expect(
      projectChatDisplayMessages([conversationMirror("pending"), conversationMirror("delivered")]),
    ).toEqual([conversationMirror("delivered")]);
  });
});
