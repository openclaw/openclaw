import { describe, expect, it } from "vitest";
import { createQuickReplyItems } from "./send.js";

describe("createQuickReplyItems", () => {
  it("limits items to 13 (LINE maximum)", () => {
    const labels = Array.from({ length: 20 }, (_, i) => `Option ${i + 1}`);
    const quickReply = createQuickReplyItems(labels);

    expect(quickReply.items).toHaveLength(13);
  });
});
