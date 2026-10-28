import { describe, expect, it } from "vitest";
import { groupToolCalls, type ToolCallGroup, type ToolCallIdentity } from "./tool-call-grouping.js";

function toolCard(callId: string, overrides: Partial<ToolCallIdentity> = {}): ToolCallIdentity {
  return { callId, runId: "run", ...overrides };
}

describe("groupToolCalls", () => {
  const child = toolCard("child", { parentToolCallId: "outer" });
  const parallel = toolCard("parallel");
  const grandchild = toolCard("grandchild", { parentToolCallId: "child" });
  const outer = toolCard("outer");
  const secondChild = toolCard("second-child", { parentToolCallId: "outer" });
  const parallelChild = toolCard("parallel-child", { parentToolCallId: "parallel" });
  const descendant = toolCard("child", { parentToolCallId: "a" });
  const a = toolCard("a", { parentToolCallId: "b" });
  const b = toolCard("b", { parentToolCallId: "a" });

  it.each<[string, ToolCallIdentity[], ToolCallGroup[]?]>([
    [
      "nested and interleaved operations arriving before their parents",
      [child, parallel, grandchild, outer, secondChild, parallelChild],
      [
        { card: parallel, children: [{ card: parallelChild, children: [] }] },
        {
          card: outer,
          children: [
            { card: child, children: [{ card: grandchild, children: [] }] },
            { card: secondChild, children: [] },
          ],
        },
      ],
    ],
    [
      "a child with no recorded run",
      [toolCard("outer"), toolCard("child", { runId: undefined, parentToolCallId: "outer" })],
    ],
    [
      "a parent with no recorded run",
      [toolCard("outer", { runId: undefined }), toolCard("child", { parentToolCallId: "outer" })],
    ],
    [
      "a display id without a recorded parent call id",
      [toolCard("outer", { callId: undefined }), toolCard("child", { parentToolCallId: "outer" })],
    ],
    [
      "call ids reused across different runs",
      [toolCard("outer"), toolCard("child", { runId: "other", parentToolCallId: "outer" })],
    ],
    ["a self-parent", [toolCard("self", { parentToolCallId: "self" })]],
    [
      "ambiguous duplicate call identities and their children",
      [
        toolCard("outer"),
        toolCard("duplicate", { parentToolCallId: "outer" }),
        toolCard("duplicate", { parentToolCallId: "outer" }),
        toolCard("child", { parentToolCallId: "duplicate" }),
      ],
    ],
    [
      "valid descendants of cyclic ancestors",
      [descendant, a, b],
      [
        { card: a, children: [{ card: descendant, children: [] }] },
        { card: b, children: [] },
      ],
    ],
    [
      "a stack-safe long cycle",
      Array.from({ length: 20_000 }, (_, index) =>
        toolCard(String(index), { parentToolCallId: String((index + 1) % 20_000) }),
      ),
    ],
  ])("preserves grouping and reachability for %s", (_label, cards, expected) => {
    const groups = groupToolCalls(Object.freeze(cards.map((card) => Object.freeze(card))));
    expect(groups).toEqual(expected ?? cards.map((card) => ({ card, children: [] })));
    if (!expected) {
      expect(groups.map((group) => group.card)).toEqual(cards);
      expect(groups.every((group) => group.children.length === 0)).toBe(true);
    }
  });
});
