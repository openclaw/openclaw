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
  it.each<[string, ToolGroupSummaryInput[], string]>([
    ["a single command", [{ name: "bash", args: { command: "ls" } }], "Ran a command"],
    [
      "the operations inside a wrapper, without counting the wrapper twice",
      [
        { name: "exec", callId: "outer", runId: "run", args: { title: "Inspect project" } },
        {
          name: "read",
          callId: "child",
          parentToolCallId: "outer",
          runId: "run",
          args: { path: "README.md" },
        },
      ],
      "Read a file",
    ],
    [
      "unrelated runs that reuse a call id",
      [
        { name: "exec", callId: "outer", runId: "previous" },
        {
          name: "read",
          callId: "child",
          parentToolCallId: "outer",
          runId: "current",
          args: { path: "README.md" },
        },
      ],
      "Ran a command, read a file",
    ],
    [
      "a failed wrapper even when its child succeeded",
      [
        { name: "exec", callId: "outer", runId: "run", isError: true },
        {
          name: "read",
          callId: "child",
          parentToolCallId: "outer",
          runId: "run",
          args: { path: "README.md" },
        },
      ],
      "Ran a command, read a file",
    ],
    [
      "ambiguous wrapper identities without hiding their operations",
      [
        { name: "exec", callId: "outer", runId: "run" },
        { name: "exec", callId: "outer", runId: "run" },
        {
          name: "read",
          callId: "child",
          parentToolCallId: "outer",
          runId: "run",
          args: { path: "README.md" },
        },
      ],
      "Ran 2 commands, read a file",
    ],
    [
      "cyclic operations alongside an unrelated call",
      [
        { name: "exec", callId: "a", parentToolCallId: "b", runId: "run" },
        { name: "exec", callId: "b", parentToolCallId: "a", runId: "run" },
        { name: "read", args: { path: "README.md" } },
      ],
      "Ran 2 commands, read a file",
    ],
    [
      "named tools in original activity order across nested operations",
      [
        { name: "exec", callId: "outer", runId: "run" },
        { name: "alpha", callId: "child", parentToolCallId: "outer", runId: "run" },
        { name: "beta", callId: "parallel", runId: "run" },
      ],
      "Used Alpha, Beta",
    ],
    [
      "an ordinary exec with code-shaped arguments",
      [{ name: "exec", args: { code: "a business value", command: "echo ok" } }],
      "Ran a command",
    ],
    [
      "distinct paths over call count",
      [
        { name: "read", args: { path: "/repo/a.ts" } },
        { name: "read", args: { path: "/repo/a.ts" } },
        { name: "read", args: { path: "/repo/b.ts" } },
      ],
      "Read 2 files",
    ],
    [
      "call count when reads carry no paths",
      [
        { name: "read", args: {} },
        { name: "read", args: {} },
      ],
      "Read 2 files",
    ],
    [
      "multiple searches",
      [
        { name: "grep", args: { pattern: "a" } },
        { name: "glob", args: { pattern: "b" } },
      ],
      "Ran 2 searches",
    ],
    [
      "command-discriminated text editor calls",
      [
        {
          name: "str_replace_editor",
          args: { command: "view", file_path: "/repo/a.ts", view_range: [1, 20] },
        },
        {
          name: "str_replace_based_edit_tool",
          args: {
            command: "str_replace",
            file: "/repo/a.ts",
            old_str: "old",
            new_str: "new",
          },
        },
        {
          name: "str_replace_editor",
          args: { command: "insert", filepath: "/repo/a.ts", insert_text: "line" },
        },
        {
          name: "str_replace_based_edit_tool",
          args: { command: "create", filename: "/repo/new.ts", file_text: "new" },
        },
      ],
      "Read a file, edited a file, created a file",
    ],
    [
      "text editor calls without a recognized command",
      [
        { name: "str_replace_editor", args: { path: "/repo/a.ts" } },
        { name: "str_replace_based_edit_tool", args: { command: "rename" } },
      ],
      "Used Str Replace Editor, Str Replace Based Edit Tool",
    ],
    [
      "multi-file apply_patch targets",
      [
        {
          name: "apply_patch",
          args: {
            patch: [
              "*** Begin Patch",
              "*** Update File: src/a.ts",
              "@@",
              "-old",
              "+new",
              "*** Add File: src/b.ts",
              "+new",
              "*** End Patch",
            ].join("\n"),
          },
        },
      ],
      "Edited a file, created a file",
    ],
    [
      "structured Codex change targets",
      [
        {
          name: "apply_patch",
          args: {
            changes: [
              { path: "src/a.ts", kind: { type: "update" } },
              { path: "src/b.ts", kind: { type: "add" } },
            ],
          },
        },
      ],
      "Edited a file, created a file",
    ],
    [
      "deleted Codex targets",
      [
        {
          name: "apply_patch",
          args: {
            changes: [{ path: "src/obsolete.ts", kind: { type: "delete" } }],
          },
        },
      ],
      "Deleted a file",
    ],
    ["one generic tool by name", [{ name: "mcp__linear" }], "Used Mcp Linear"],
    [
      "repeat generic tool with a multiplier",
      [{ name: "heartbeat_respond" }, { name: "heartbeat_respond" }],
      "Used Heartbeat Respond ×2",
    ],
    [
      "many distinct generic tools as a count",
      [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      "Used 3 tools",
    ],
  ])("summarizes %s", (_label, cards, expected) => {
    expect(summarizeToolGroup(cards)).toBe(expected);
  });
});
