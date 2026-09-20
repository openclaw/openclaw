/* @vitest-environment jsdom */

import { render } from "lit";
import { expect, it, vi } from "vitest";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
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
    expect(activity?.textContent).toContain("2 reads");
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
    expect(summary?.textContent).toContain("1 read");
    expect(summary?.textContent?.match(/1 failed/gu)).toHaveLength(1);
    if (kind === "work") {
      expect(summary?.textContent).toContain("1s");
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
  expect(summary?.textContent).toContain("1 read");
  expect(summary?.textContent).not.toContain("failed");
  expect(summary?.querySelector(".chat-tool-failure")).toBeNull();
});
