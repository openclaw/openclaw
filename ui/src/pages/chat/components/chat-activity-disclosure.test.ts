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
import { renderMessageGroup, renderWorkGroupSummary } from "./chat-message.ts";

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
    expect(activity?.textContent).toContain("Read ×2");
    expect(activity?.querySelector("[title], [data-tooltip], openclaw-tooltip")).toBeNull();
    expect(activity?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".chat-activity-group")).toHaveLength(1);
    expect(container.querySelector(".chat-tool-msg-body")).toBeNull();
    activity?.click();
    expect(onToggle).toHaveBeenCalledOnce();
  },
);
