import { describe, expect, it } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("tool-cards", () => {
  it("propagates result text and call arguments across paired tool cards", () => {
    const cards = extractToolCards({
      role: "assistant",
      content: [
        {
          type: "toolcall",
          name: "read",
          arguments: { path: "README.md" },
        },
        {
          type: "toolresult",
          name: "read",
          text: "README contents",
        },
      ],
    });

    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({
      kind: "call",
      name: "read",
      text: "README contents",
      args: { path: "README.md" },
    });
    expect(cards[1]).toMatchObject({
      kind: "result",
      name: "read",
      text: "README contents",
      args: { path: "README.md" },
    });
  });
});
