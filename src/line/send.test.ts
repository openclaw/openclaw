import { describe, expect, it } from "vitest";
import { createQuickReplyItems } from "./send.js";

describe("createQuickReplyItems", () => {
  it("creates quick reply items from labels", () => {
    const quickReply = createQuickReplyItems(["Option 1", "Option 2", "Option 3"]);

    expect(quickReply.items).toHaveLength(3);
    expect((quickReply.items[0].action as { label: string }).label).toBe("Option 1");
    expect((quickReply.items[0].action as { text: string }).text).toBe("Option 1");
  });

  it("limits items to 13 (LINE maximum)", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
    const quickReply = createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });

  it("truncates labels to 20 characters", () => {
    const quickReply = createQuickReplyItems([
      "This is a very long option label that exceeds the limit",
    ]);

    expect((quickReply.items[0].action as { label: string }).label).toBe("This is a very long ");
    // Text is not truncated
    expect((quickReply.items[0].action as { text: string }).text).toBe(
      "This is a very long option label that exceeds the limit",
    );
  });
});
