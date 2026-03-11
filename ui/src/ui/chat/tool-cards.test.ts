import { describe, expect, it } from "vitest";
import { extractToolCards } from "./tool-cards.ts";

describe("extractToolCards", () => {
  it("reuses the matching call args for tool results in the same message", () => {
    const command =
      "python3 ~/.openclaw/workspace/skills/node-cluster-3.connector/scripts/main.py invoke " +
      'wangjx-node-host system.run --raw-command "echo sidebar"';
    const cards = extractToolCards({
      content: [
        {
          type: "tool_call",
          name: "exec",
          arguments: { command },
        },
        {
          type: "tool_result",
          name: "exec",
          text: "done",
        },
      ],
    });

    expect(cards).toHaveLength(2);
    expect(cards[1]).toEqual(
      expect.objectContaining({
        kind: "result",
        name: "exec",
        args: { command },
        text: "done",
      }),
    );
  });
});
