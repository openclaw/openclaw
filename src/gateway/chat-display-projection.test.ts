import { describe, expect, it } from "vitest";
import { projectChatDisplayMessages } from "./chat-display-projection.js";

describe("chat display projection", () => {
  it("hides empty assistant failure shells", () => {
    const messages = projectChatDisplayMessages([
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "[assistant turn failed before producing content]" }],
        timestamp: 2,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "real reply" }],
        timestamp: 3,
      },
    ]);

    expect(messages.map((message) => message.content)).toEqual([
      [{ type: "text", text: "real reply" }],
    ]);
  });
});
