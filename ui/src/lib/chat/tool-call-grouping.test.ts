// Control UI tests cover tool nesting and collapsed group summaries.
import { describe, expect, it } from "vitest";
import type { ToolCard } from "./chat-types.ts";
import { groupToolCards, summarizeToolGroup } from "./tool-call-grouping.ts";

type ToolGroupSummaryInput = Parameters<typeof summarizeToolGroup>[0][number];

function toolCard(callId: string, overrides: Partial<ToolCard> = {}): ToolCard {
  return { id: callId, callId, runId: "run", name: "exec", ...overrides };
}

describe("groupToolCards", () => {
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

    expect(groupToolCards(cards)).toEqual([
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

  it.each<[string, ToolCard[]]>([
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
        toolCard("duplicate", { parentToolCallId: "outer", id: "duplicate-result" }),
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
    expect(groupToolCards(cards)).toEqual(cards.map((card) => ({ card, children: [] })));
  });

  it("keeps valid descendants reachable when their ancestors have cyclic parent records", () => {
    const child = toolCard("child", { parentToolCallId: "a" });
    const a = toolCard("a", { parentToolCallId: "b" });
    const b = toolCard("b", { parentToolCallId: "a" });

    expect(groupToolCards([child, a, b])).toEqual([
      { card: a, children: [{ card: child, children: [] }] },
      { card: b, children: [] },
    ]);
  });

  it("keeps every operation accessible in a long cycle without recursive traversal", () => {
    const cards = Array.from({ length: 20_000 }, (_, index) =>
      toolCard(String(index), { parentToolCallId: String((index + 1) % 20_000) }),
    );
    const groups = groupToolCards(cards);

    expect(groups.map((group) => group.card)).toEqual(cards);
    expect(groups.every((group) => group.children.length === 0)).toBe(true);
  });
});

describe("summarizeToolGroup", () => {
  const prepared = (
    itemId: string,
    title: string,
    extra: Partial<ToolGroupSummaryInput> = {},
  ): ToolGroupSummaryInput => ({
    itemId,
    title,
    kind: "tool",
    phase: "end",
    status: "completed",
    ...extra,
  });

  it("counts prepared operations without copying their free-form titles", () => {
    expect(
      summarizeToolGroup([
        prepared("first", "Check samples", { name: "custom_tool" }),
        prepared("second", "Edit report", { name: "edit" }),
        prepared("third", "Check samples"),
      ]),
    ).toBe("1 edit · 2 other operations");
  });

  it("replaces running state with the same operation's outcome without counting suppressed siblings", () => {
    expect(
      summarizeToolGroup([
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "running", phase: "start" }),
        prepared("tool:call", "Inspect", { toolCallId: "call", status: "failed" }),
        prepared("command:call", "Command", { toolCallId: "call", suppressChannelProgress: true }),
      ]),
    ).toBe("1 other operation · 1 failed");
  });

  it("keeps failure, approval, and unknown outcomes while quiet work stays out", () => {
    expect(
      summarizeToolGroup([
        prepared("quiet", "Wait", { hideFromChannelProgress: true }),
        prepared("failure", "Check process", { status: "failed" }),
        prepared("approval", "Write report", { status: "blocked" }),
        prepared("unknown", "Outcome unknown", { status: undefined }),
      ]),
    ).toBe("3 other operations · 1 failed · 1 blocked · 1 unknown");
  });

  it("keeps the diagnostic disclosure label when all prepared work is quiet", () => {
    expect(summarizeToolGroup([])).toBe(
      summarizeToolGroup([prepared("quiet", "Wait", { hideFromChannelProgress: true })]),
    );
    expect(summarizeToolGroup([])).not.toBe("");
  });

  it("bounds dense summaries independently of command, title, and custom-name length", () => {
    const items = Array.from({ length: 500 }, (_, index) =>
      prepared(`call-${index}`, `print text → ${"/workspace/deep/path ".repeat(100)}`, {
        name: index % 2 === 0 ? "exec" : `custom_${"long".repeat(100)}_${index}`,
      }),
    );
    expect(summarizeToolGroup(items)).toBe("250 commands · 250 other operations");
    expect(summarizeToolGroup([prepared("custom", "constructor", { name: "constructor" })])).toBe(
      "1 other operation",
    );
    expect(
      summarizeToolGroup([prepared("command", "Native command", { commandBearing: true })]),
    ).toBe("1 command");
  });
});
