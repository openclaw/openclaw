/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
  createToolResultMessage,
  prepareHistoryGroups,
} from "./chat-message.test-support.ts";
import { renderActivityGroup, renderMessageGroup, renderWorkGroupSummary } from "./chat-message.ts";

it.each(["activity", "work"] as const)(
  "keeps parallel tool activity expandable without hover text (%s)",
  (kind) => {
    const container = document.createElement("div");
    const groups = prepareHistoryGroups([
      createToolGroup("parallel-tool-group", [
        createMessageEntry(
          "parallel-tool-message",
          createAssistantMessage(
            [
              createToolCall("call-a", "read", { path: "/repo/a.ts" }, { type: "toolCall" }),
              createToolCall("call-b", "read", { path: "/repo/b.ts" }, { type: "toolCall" }),
              createToolResultBlock("call-a", "read", "File A", { isError: false }),
              createToolResultBlock("call-b", "read", "File B", { isError: false }),
            ],
            { timestamp: 1000 },
          ),
        ),
      ]),
    ]);
    const onToggle = vi.fn();
    render(
      kind === "activity"
        ? groups.map((group) =>
            renderMessageGroup(group, {
              showToolCalls: true,
              showReasoning: true,
              isToolMessageExpanded: () => false,
              onToggleToolMessageExpanded: onToggle,
            }),
          )
        : renderWorkGroupSummary(
            { key: "parallel-work", durationMs: 1000, groups },
            { expanded: false, onToggle },
          ),
      container,
    );

    const activity = container.querySelector<HTMLButtonElement>(".chat-activity-group__summary");
    expect(activity?.textContent).toContain(kind === "work" ? "Worked for 1s" : "2 reads");
    if (kind === "work") {
      expect(activity?.textContent).toContain("2 tool calls");
      expect(activity?.textContent).not.toContain("failed");
    }
    expect(activity?.querySelector("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    expect(activity?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".chat-activity-group")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    activity?.click();
    expect(onToggle).toHaveBeenCalledOnce();
  },
);

it.each([
  ["activity", "anonymous"],
  ["activity", "missing-card"],
  ["activity", "matched"],
  ["work", "anonymous"],
  ["work", "missing-card"],
  ["work", "matched"],
] as const)("retains prepared failures exactly once in %s summaries (%s)", (kind, pairing) => {
  const message = createAssistantMessage(
    pairing === "missing-card"
      ? [{ type: "text", text: "Operation details unavailable" }]
      : [
          createToolCall("call-failed", "read", { path: "/repo/private.ts" }),
          createToolResultBlock("call-failed", "read", "Permission denied", { isError: true }),
        ],
    {
      activity: [
        {
          itemId: "prepared-failure",
          ...(pairing === "matched" ? { toolCallId: "call-failed" } : {}),
          kind: "tool",
          phase: "end",
          name: "read",
          title: "Read file",
          status: "failed",
        },
      ],
    },
  );
  const groups = [createToolGroup("failed-group", [createMessageEntry("failed-entry", message)])];
  const container = document.createElement("div");
  for (const expanded of [false, true]) {
    render(
      kind === "activity"
        ? renderActivityGroup(groups, {
            showToolCalls: true,
            showReasoning: true,
            isToolMessageExpanded: () => expanded,
          })
        : renderWorkGroupSummary(
            { key: "failed-work", durationMs: 1000, groups },
            { expanded, onToggle: () => {} },
          ),
      container,
    );
    const summary = container.querySelector(".chat-activity-group__summary");
    expect(summary?.textContent).toContain(kind === "work" ? "Worked for 1s" : "1 read");
    expect(summary?.textContent?.match(/1 failed/gu)).toHaveLength(1);
    if (kind === "work") {
      expect(summary?.textContent).toContain("1 tool call");
    }
  }
});

it.each(["activity", "work"] as const)("uses current prepared outcomes in %s summaries", (kind) => {
  const completed = {
    itemId: "call:one",
    toolCallId: "one",
    kind: "tool",
    phase: "end",
    name: "read",
    title: "Read",
    status: "completed",
  };
  const message = createAssistantMessage(
    [
      createToolCall("one", "read", { path: "/repo/file.ts" }),
      createToolResultBlock("one", "read", "Older error projection", { isError: true }),
    ],
    {
      activity: [
        { ...completed, status: "failed" },
        completed,
        {
          ...completed,
          itemId: "suppressed",
          toolCallId: "suppressed",
          status: "failed",
          suppressChannelProgress: true,
        },
        { ...completed, itemId: "quiet", toolCallId: "quiet", hideFromChannelProgress: true },
      ],
    },
  );
  const groups = [createToolGroup("current", [createMessageEntry("entry", message)])];
  const container = document.createElement("div");
  render(
    kind === "activity"
      ? renderActivityGroup(groups, { showToolCalls: true, showReasoning: true })
      : renderWorkGroupSummary(
          { key: "work", durationMs: 1000, groups },
          { expanded: false, onToggle: () => {} },
        ),
    container,
  );
  const summary = container.querySelector(".chat-activity-group__summary");
  expect(summary?.textContent).toContain(kind === "work" ? "Worked for 1s" : "1 read");
  expect(summary?.textContent).not.toContain("failed");
  if (kind === "work") {
    expect(summary?.textContent).toContain("1 tool call");
    expect(summary?.textContent).not.toContain("2 tool calls");
  }
  expect(summary?.querySelector(".chat-tool-failure")).toBeNull();
});

it.each(["blocked", undefined] as const)(
  "retains %s outcomes when completed work is expanded",
  (status) => {
    const message = createAssistantMessage([], {
      activity: [
        {
          itemId: "outcome",
          kind: "tool",
          phase: "end",
          name: "read",
          title: "Read",
          ...(status ? { status } : {}),
        },
      ],
    });
    const groups = [
      createToolGroup("outcome-group", [createMessageEntry("outcome-entry", message)]),
    ];
    const container = document.createElement("div");
    for (const expanded of [false, true]) {
      render(
        renderWorkGroupSummary(
          { key: "outcome-work", durationMs: 1000, groups },
          { expanded, onToggle: () => {} },
        ),
        container,
      );
      const summary = container.querySelector(".chat-activity-group__summary");
      expect(summary?.textContent).toContain("Worked for 1s");
      expect(summary?.textContent).toContain("1 tool call");
      expect(summary?.textContent).toContain(status ? "1 blocked" : "1 unknown");
    }
  },
);

it.each([0, 10])("shows the total alongside failures without a duration (%i calls)", (total) => {
  const groups = prepareHistoryGroups([
    createToolGroup("mixed", [
      createMessageEntry(
        "mixed-message",
        createAssistantMessage(
          Array.from({ length: total }, (_, index) => [
            createToolCall(`call-${index}`, "read", { path: `/repo/${index}.ts` }),
            createToolResultBlock(`call-${index}`, "read", index < 2 ? "Unavailable" : "Loaded", {
              isError: index < 2,
            }),
          ]).flat(),
        ),
      ),
    ]),
  ]);
  const container = document.createElement("div");
  render(
    renderWorkGroupSummary(
      { key: "mixed-work", durationMs: null, groups },
      { expanded: false, onToggle: () => {} },
    ),
    container,
  );
  const summary = container.querySelector(".chat-activity-group__summary");
  const text = summary?.textContent?.replace(/\s+/gu, " ").trim();
  expect(text).toBe(total ? "Worked · 10 tool calls · 2 failed" : "Worked");
});

it("counts a raw call and its separate result once", () => {
  const groups = [
    createToolGroup("raw", [
      createMessageEntry("call", createAssistantMessage([createToolCall("one", "read", {})])),
      createMessageEntry(
        "result",
        createToolResultMessage("one", "read", "Unavailable", { isError: true }),
      ),
    ]),
  ];
  const container = document.createElement("div");
  render(
    renderWorkGroupSummary(
      { key: "raw-work", durationMs: 1000, groups },
      { expanded: false, onToggle: () => {} },
    ),
    container,
  );
  const text = container.querySelector(".chat-activity-group__summary")?.textContent;
  expect(text).toContain("1 tool call");
  expect(text).toContain("1 failed");
  expect(text).not.toContain("2 tool calls");
});

function workSummaryText(messages: Record<string, unknown>[]) {
  const groups = [
    createToolGroup(
      "history",
      messages.map((message, index) => createMessageEntry(`message-${index}`, message)),
    ),
  ];
  const container = document.createElement("div");
  render(
    renderWorkGroupSummary(
      { key: "work", durationMs: null, groups },
      { expanded: false, onToggle: () => {} },
    ),
    container,
  );
  return container
    .querySelector(".chat-activity-group__summary")
    ?.textContent?.replace(/\s+/gu, " ")
    .trim();
}

it.each([
  [true, false],
  [false, true],
  [true, true],
])("keeps anonymous calls and their failures distinct (%s, %s)", (firstFailed, secondFailed) => {
  const messages = [firstFailed, secondFailed].map((isError) => ({
    role: "toolResult",
    toolName: "exec",
    content: isError ? "Command failed" : "Command completed",
    isError,
  }));
  const failures = Number(firstFailed) + Number(secondFailed);
  expect(workSummaryText(messages)).toBe(`Worked · 2 tool calls · ${failures} failed`);
});

it.each([false, true])("counts mixed prepared and raw history (reverse=%s)", (reverse) => {
  const prepared = createToolResultMessage("prepared", "read", "Stale raw failure", {
    isError: true,
    activity: [
      {
        itemId: "tool:prepared",
        toolCallId: "prepared",
        kind: "tool",
        phase: "end",
        name: "read",
        title: "Read",
        status: "completed",
      },
    ],
  });
  const messages = [
    createAssistantMessage([createToolCall("prepared", "read", {})]),
    prepared,
    createAssistantMessage([createToolCall("raw", "read", {})]),
    createToolResultMessage("raw", "read", "Permission denied", { isError: true }),
  ];
  if (reverse) {
    messages.splice(0, 2, prepared, messages[0]!);
  }
  expect(workSummaryText(messages)).toBe("Worked · 2 tool calls · 1 failed");
});

it.each(["empty", "hidden", "suppressed"] as const)(
  "does not resurrect %s prepared calls from raw history",
  (kind) => {
    const activity =
      kind === "empty"
        ? []
        : [
            {
              itemId: "tool:quiet",
              toolCallId: "quiet",
              kind: "tool",
              phase: "end",
              name: "read",
              title: "Read",
              status: "failed",
              ...(kind === "hidden"
                ? { hideFromChannelProgress: true }
                : { suppressChannelProgress: true }),
            },
          ];
    expect(
      workSummaryText([
        createAssistantMessage([createToolCall("quiet", "read", {})]),
        createToolResultMessage("quiet", "read", "Hidden failure", { isError: true, activity }),
        createToolResultMessage("visible", "read", "Visible failure", { isError: true }),
      ]),
    ).toBe("Worked · 1 tool call · 1 failed");
  },
);

it.each(["raw", "empty", "hidden", "suppressed", "completed", "blocked"] as const)(
  "keeps steering skips consistent with %s activity",
  (kind) => {
    const activity =
      kind === "empty"
        ? []
        : [
            {
              itemId: "tool:skip",
              toolCallId: "skip",
              kind: "tool",
              phase: "end",
              name: "exec",
              title: "Command",
              status: kind === "completed" ? "completed" : "blocked",
              ...(kind === "hidden" ? { hideFromChannelProgress: true } : {}),
              ...(kind === "suppressed" ? { suppressChannelProgress: true } : {}),
            },
          ];
    const message = createToolResultMessage("skip", "exec", "Skipped", {
      details: { status: "skipped", deniedReason: "steering" },
      ...(kind === "raw" ? {} : { activity }),
    });
    const expected =
      kind === "raw" || kind === "blocked"
        ? "Worked · 1 tool call · 1 skipped"
        : kind === "completed"
          ? "Worked · 1 tool call"
          : "Worked";
    expect(workSummaryText([message])).toBe(expected);
  },
);

it("keeps an unresolved anonymous raw call unknown", () => {
  expect(
    workSummaryText([
      createAssistantMessage([{ type: "toolCall", name: "exec", arguments: { command: "pwd" } }]),
    ]),
  ).toBe("Worked · 1 tool call · 1 unknown");
});
