import { describe, expect, it } from "vitest";
import { groupToolCalls, type ToolCallIdentity } from "./tool-call-grouping.js";

function toolCard(callId: string, overrides: Partial<ToolCallIdentity> = {}): ToolCallIdentity {
  return { callId, runId: "run", ...overrides };
}

describe("groupToolCalls", () => {
  it("groups nested and interleaved operations in sibling order even when children arrive first", () => {
    const child = toolCard("child", { parentToolCallId: "outer" });
    const parallel = toolCard("parallel");
    const grandchild = toolCard("grandchild", { parentToolCallId: "child" });
    const outer = toolCard("outer");
    const secondChild = toolCard("second-child", { parentToolCallId: "outer" });
    const parallelChild = toolCard("parallel-child", { parentToolCallId: "parallel" });
    const cards = Object.freeze(
      [child, parallel, grandchild, outer, secondChild, parallelChild].map((card) =>
        Object.freeze(card),
      ),
    );

    expect(groupToolCalls(cards)).toEqual([
      { card: parallel, children: [{ card: parallelChild, children: [] }] },
      {
        card: outer,
        children: [
          { card: child, children: [{ card: grandchild, children: [] }] },
          { card: secondChild, children: [] },
        ],
      },
    ]);
  });

  it.each<[string, ToolCallIdentity[]]>([
    [
      "unrecorded relationships between matching tool names",
      [toolCard("outer"), toolCard("child")],
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
    ["a missing parent", [toolCard("child", { parentToolCallId: "missing" })]],
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
      "a cycle",
      [
        toolCard("a", { parentToolCallId: "c" }),
        toolCard("b", { parentToolCallId: "a" }),
        toolCard("c", { parentToolCallId: "b" }),
      ],
    ],
  ])("keeps %s accessible at the top level", (_label, cards) => {
    expect(groupToolCalls(cards)).toEqual(cards.map((card) => ({ card, children: [] })));
  });

  it("keeps valid descendants reachable when their ancestors have cyclic parent records", () => {
    const child = toolCard("child", { parentToolCallId: "a" });
    const a = toolCard("a", { parentToolCallId: "b" });
    const b = toolCard("b", { parentToolCallId: "a" });

    expect(groupToolCalls([child, a, b])).toEqual([
      { card: a, children: [{ card: child, children: [] }] },
      { card: b, children: [] },
    ]);
  });

  it("keeps every operation accessible in a long cycle without recursive traversal", () => {
    const cards = Array.from({ length: 20_000 }, (_, index) =>
      toolCard(String(index), { parentToolCallId: String((index + 1) % 20_000) }),
    );
    const groups = groupToolCalls(cards);

    expect(groups.map((group) => group.card)).toEqual(cards);
    expect(groups.every((group) => group.children.length === 0)).toBe(true);
  });
});
