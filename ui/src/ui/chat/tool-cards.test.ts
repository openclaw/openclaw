import { describe, it, expect } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("extractToolCards", () => {
  const suppressedTool = "ikentic_locus_check_task";

  it("suppresses call and empty result cards for suppressWhenNoOutput tools when no result text exists", () => {
    const message = {
      content: [
        { type: "tool_call", name: suppressedTool, arguments: { taskId: "task-1" } },
        { type: "tool_result", name: suppressedTool, content: "" },
      ],
    };

    const cards = extractToolCards(message);

    expect(cards).toEqual([]);
  });

  it("keeps cards for non-suppressed tools when no result text exists", () => {
    const message = {
      content: [
        { type: "tool_call", name: "search", arguments: {} },
        { type: "tool_result", name: "search", content: "" },
      ],
    };

    const cards = extractToolCards(message);

    expect(cards.map((card) => card.kind)).toEqual(["call", "result"]);
  });

  it("does not suppress when any result has text", () => {
    const message = {
      content: [
        { type: "tool_call", name: suppressedTool, arguments: {} },
        { type: "tool_result", name: "search", content: "ok" },
      ],
    };

    const cards = extractToolCards(message);

    expect(cards.some((card) => card.kind === "call" && card.name === suppressedTool)).toBe(true);
  });
});
