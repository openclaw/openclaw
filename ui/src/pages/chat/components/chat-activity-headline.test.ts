/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { activityHeadline, type ActivityHeadline } from "./chat-activity-headline.ts";
import { renderActivityGroup } from "./chat-message-group.ts";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultMessage,
} from "./chat-message.test-support.ts";

let container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  container = document.createElement("div");
});
afterEach(() => {
  render(nothing, container);
  vi.useRealTimers();
});

function operation(key: string, status: ActivityHeadline["status"] = "running"): ActivityHeadline {
  return { key, title: "Read " + key, status };
}

function update(activity: ActivityHeadline | undefined, scope = "session:run") {
  return render(html`<button>${activityHeadline(scope, activity, "2 reads")}</button>`, container);
}

function label() {
  return container.querySelector(".chat-activity-group__label")?.textContent;
}

describe("activity headline cadence", () => {
  it("holds new copy for three seconds and replaces pending work instead of replaying a backlog", () => {
    update(operation("first"));
    vi.advanceTimersByTime(400);
    update(operation("discarded"));
    vi.advanceTimersByTime(400);
    update(operation("latest"));
    vi.advanceTimersByTime(2_199);
    expect(label()).toBe("Read first…");
    vi.advanceTimersByTime(1);
    expect(label()).toBe("Read latest…");
    expect(vi.getTimerCount()).toBe(0);

    update(operation("next"));
    vi.advanceTimersByTime(2_999);
    expect(label()).toBe("Read latest…");
    vi.advanceTimersByTime(1);
    expect(label()).toBe("Read next…");
    vi.advanceTimersByTime(30_000);
    expect(label()).toBe("Read next…");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes the same operation's ellipsis immediately without restarting its dwell", () => {
    update(operation("first"));
    vi.advanceTimersByTime(2_000);
    update(operation("first", "completed"));
    expect(label()).toBe("Read first");
    update(operation("next"));
    vi.advanceTimersByTime(999);
    expect(label()).toBe("Read first");
    vi.advanceTimersByTime(1);
    expect(label()).toBe("Read next…");
  });

  it.each(["failed", "blocked"] as const)(
    "shows %s immediately and discards pending copy",
    (status) => {
      update(operation("first"));
      vi.advanceTimersByTime(100);
      update(operation("pending"));
      update(operation("urgent", status));
      expect(label()).toBe("Read urgent");
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(3_000);
      expect(label()).toBe("Read urgent");
    },
  );

  it("clears to the summary immediately and cannot resurrect a pending headline", () => {
    update(operation("first"));
    update(operation("pending"));
    update(undefined);
    expect(label()).toBe("2 reads");
    expect(container.querySelector(".chat-activity-group__label--live")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(label()).toBe("2 reads");
    update(operation("fresh"));
    expect(label()).toBe("Read fresh…");
  });

  it("bypasses dwell on a scope change and cancels the previous scope's callback", () => {
    update(operation("first"));
    update(operation("stale"));
    update(operation("fresh"), "other-session:other-run");
    expect(label()).toBe("Read fresh…");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(label()).toBe("Read fresh…");
  });

  it("starts a fresh dwell when a new scope reuses the same operation identity", () => {
    update(operation("first"));
    vi.advanceTimersByTime(2_000);
    update(operation("stale"));
    update(operation("first"), "new-scope");
    update(operation("next"), "new-scope");
    vi.advanceTimersByTime(2_999);
    expect(label()).toBe("Read first…");
    vi.advanceTimersByTime(1);
    expect(label()).toBe("Read next…");
  });

  it("cancels its timer while disconnected and resumes with only the latest pending operation", () => {
    const root = update(operation("first"));
    update(operation("pending"));
    expect(vi.getTimerCount()).toBe(1);
    root.setConnected(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(label()).toBe("Read first…");
    root.setConnected(true);
    expect(label()).toBe("Read pending…");
    expect(vi.getTimerCount()).toBe(0);
  });
});

function group(key: string, activity: AgentActivityItem[], runId = "active-run") {
  return createToolGroup(key, [
    createMessageEntry(
      key + ":entry",
      createAssistantMessage(
        activity.map((item) =>
          createToolCall(item.toolCallId!, item.name!, { path: "/repo/file.ts" }),
        ),
        { runId, activity },
      ),
    ),
  ]);
}

function prepared(key: string, status: AgentActivityItem["status"] = "running"): AgentActivityItem {
  return {
    itemId: key,
    toolCallId: key,
    kind: "tool",
    name: "read",
    title: "Read " + key,
    phase: status === "running" ? "start" : "end",
    status,
  };
}

const liveOptions = {
  showToolCalls: true,
  showReasoning: false,
  runActive: true,
  activityRunId: "active-run",
};

it("keeps the headline and its dwell across disclosure toggles with accessible controls", () => {
  let expanded = false;
  const onToggle = vi.fn();
  const draw = (activity: AgentActivityItem[]) =>
    render(
      renderActivityGroup([group("current", activity)], {
        ...liveOptions,
        isToolMessageExpanded: () => expanded,
        onToggleToolMessageExpanded: onToggle,
      }),
      container,
    );
  draw([prepared("first")]);
  const summary = container.querySelector<HTMLButtonElement>(".chat-activity-group__summary")!;
  const body = container.querySelector<HTMLElement>(".chat-activity-group__body")!;
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(summary.getAttribute("aria-controls")).toBe(body.id);
  expect(body.hidden).toBe(true);
  summary.click();
  expect(onToggle).toHaveBeenCalledWith("activity:current", false);

  vi.advanceTimersByTime(1_000);
  draw([prepared("first", "completed")]);
  expanded = true;
  draw([prepared("first", "completed"), prepared("next")]);
  expect(label()).toBe("Read first");
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  expect(body.hidden).toBe(false);
  expect(container.querySelector(".chat-activity-group__summary")).toBe(summary);
  vi.advanceTimersByTime(1_999);
  expect(label()).toBe("Read first");
  vi.advanceTimersByTime(1);
  expect(label()).toBe("Read next…");
  expanded = false;
  draw([prepared("first", "completed"), prepared("next", "completed")]);
  expect(label()).toBe("Read next");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
});

it("retains the latest completed operation between tools and returns to counts when the run ends", () => {
  const groups = [group("current", [prepared("finished", "completed")])];
  render(renderActivityGroup(groups, liveOptions), container);
  expect(label()).toBe("Read finished");
  render(renderActivityGroup([group("current", [prepared("next")])], liveOptions), container);
  expect(label()).toBe("Read finished");
  render(renderActivityGroup(groups, { ...liveOptions, runActive: false }), container);
  expect(label()).toBe("1 read");
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(3_000);
  expect(label()).toBe("1 read");
});

it.each(["failed", "blocked"] as const)(
  "prioritizes a new %s outcome over running and pending operations",
  (status) => {
    render(renderActivityGroup([group("current", [prepared("first")])], liveOptions), container);
    render(
      renderActivityGroup(
        [group("current", [prepared("first"), prepared("pending")])],
        liveOptions,
      ),
      container,
    );
    render(
      renderActivityGroup(
        [group("current", [prepared("first"), prepared("urgent", status)])],
        liveOptions,
      ),
      container,
    );
    expect(label()).toBe("Read urgent");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000);
    expect(label()).toBe("Read urgent");
  },
);

it("selects only visible activity from the matching run and newest eligible group", () => {
  const groups = [
    group("old", [prepared("history", "completed")], "old-run"),
    group("current", [
      prepared("current"),
      { ...prepared("hidden"), hideFromChannelProgress: true },
      { ...prepared("suppressed"), suppressChannelProgress: true },
    ]),
    group("peer", [prepared("peer")], "peer-run"),
  ];
  render(renderActivityGroup(groups, { ...liveOptions, activityGroupKey: "current" }), container);
  expect(label()).toBe("Read current…");
  render(
    renderActivityGroup(groups, { ...liveOptions, activityGroupKey: "newer-group" }),
    container,
  );
  expect(label()).toBe("3 reads");
  render(renderActivityGroup(groups, { ...liveOptions, activityRunId: "absent-run" }), container);
  expect(label()).toBe("3 reads");
  vi.advanceTimersByTime(3_000);
  expect(label()).toBe("3 reads");
});

it("uses the newest group's live card label without inheriting an earlier failure", () => {
  const groups = [
    createToolGroup("live-first", [
      createMessageEntry(
        "failed-read",
        createToolResultMessage("call-read", "read", JSON.stringify({ error: "failed" }), {
          isError: true,
          runId: "active-run",
          activity: [
            projectAgentToolActivity({
              toolCallId: "call-read",
              name: "read",
              phase: "result",
              isError: true,
            }),
          ],
        }),
      ),
    ]),
    createToolGroup(
      "live-second",
      [
        createMessageEntry("running-edit", {
          role: "assistant",
          runId: "active-run",
          activity: [
            projectAgentToolActivity({
              toolCallId: "call-edit",
              name: "edit",
              phase: "start",
              args: { path: "/repo/src/a.ts" },
            }),
          ],
          __openclawToolStreamLive: true,
          __openclawToolStreamResultReceived: false,
          content: [
            {
              type: "tool_use",
              id: "call-edit",
              name: "edit",
              input: { path: "/repo/src/a.ts", oldText: "old", newText: "new" },
            },
          ],
        }),
      ],
      { isStreaming: true },
    ),
  ];
  const opts = {
    showReasoning: true,
    showToolCalls: true,
    runActive: true,
    activityRunId: "active-run",
  };

  render(renderActivityGroup(groups, opts), container);
  const activitySummary = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group__summary",
  )!;
  expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
  expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
  expect(activitySummary.getAttribute("aria-label")).toBeNull();
  expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
  expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
    "Edit in /repo/src/a.ts…",
  );

  render(renderActivityGroup(groups, { ...opts, runActive: false }), container);
  expect(activitySummary.textContent?.replace(/\s+/gu, " ").trim()).toBe(
    "1 read · 1 edit 1 failed",
  );
});

it("uses the prepared running mutation title in an active group summary", () => {
  const group = createToolGroup(
    "running-tool-group",
    [
      createMessageEntry("finished-read", {
        role: "toolResult",
        runId: "active-mutation",
        toolCallId: "call-read",
        toolName: "read",
        activity: [
          projectAgentToolActivity({
            toolCallId: "call-read",
            name: "read",
            phase: "result",
            isError: false,
          }),
        ],
        content: "done",
      }),
      createMessageEntry("running-edit", {
        role: "assistant",
        runId: "active-mutation",
        activity: [
          projectAgentToolActivity({
            toolCallId: "call-edit",
            name: "edit",
            phase: "start",
            args: { path: "/repo/src/a.ts" },
          }),
        ],
        __openclawToolStreamLive: true,
        __openclawToolStreamResultReceived: false,
        content: [
          {
            type: "tool_use",
            id: "call-edit",
            name: "edit",
            input: { path: "/repo/src/a.ts", oldText: "old", newText: "new" },
          },
        ],
      }),
    ],
    { timestamp: 1000, isStreaming: true },
  );

  render(
    renderActivityGroup([group], {
      runActive: true,
      activityRunId: "active-mutation",
      showReasoning: false,
    }),
    container,
  );

  expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
    "Edit in /repo/src/a.ts…",
  );
});

it("refreshes a held operation's status when completion and the next start arrive together", () => {
  render(renderActivityGroup([group("current", [prepared("first")])], liveOptions), container);
  vi.advanceTimersByTime(200);
  render(
    renderActivityGroup(
      [group("current", [prepared("first", "completed"), prepared("next")])],
      liveOptions,
    ),
    container,
  );
  expect(label()).toBe("Read first");
  vi.advanceTimersByTime(2_800);
  expect(label()).toBe("Read next…");
});

it.each(["failed", "blocked"] as const)(
  "preserves a nested child's %s urgency under its parent purpose",
  (status) => {
    render(renderActivityGroup([group("current", [prepared("first")])], liveOptions), container);
    const parent = { ...prepared("parent"), name: "exec", title: "Build the snake game" };
    const child = prepared("child", status);
    const nested = createToolGroup("current", [
      createMessageEntry(
        "nested",
        createAssistantMessage(
          [
            createToolCall(
              "parent",
              "exec",
              { title: parent.title, code: "// Build game" },
              { runId: "active-run" },
            ),
            createToolCall(
              "child",
              "write",
              { path: "index.html" },
              { runId: "active-run", parentToolCallId: "parent" },
            ),
          ],
          { runId: "active-run", activity: [parent, child] },
        ),
      ),
    ]);
    render(renderActivityGroup([nested], liveOptions), container);
    expect(label()).toBe("Build the snake game");
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector(".chat-activity-group__summary")?.textContent).toContain(
      "1 " + status,
    );
  },
);

it("uses the latest status when start and result projections coexist", () => {
  render(renderActivityGroup([group("current", [prepared("first")])], liveOptions), container);
  vi.advanceTimersByTime(200);
  const settled = [prepared("first"), prepared("first", "completed")];
  render(renderActivityGroup([group("current", settled)], liveOptions), container);
  expect(label()).toBe("Read first");
  render(
    renderActivityGroup([group("current", [...settled, prepared("next")])], liveOptions),
    container,
  );
  expect(label()).toBe("Read first");
  vi.advanceTimersByTime(2_800);
  expect(label()).toBe("Read next…");
});
