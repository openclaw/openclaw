import { describe, expect, it } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("extractToolCards", () => {
  it("synthesizes a tool result card for subagent announce injections", () => {
    const cards = extractToolCards({
      role: "user",
      content: "Final subagent findings",
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
      },
    });

    expect(cards).toEqual([
      {
        kind: "result",
        name: "subagents",
        text: "Final subagent findings",
      },
    ]);
  });
});
