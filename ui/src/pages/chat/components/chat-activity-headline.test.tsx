/* @vitest-environment jsdom */

import { createSignal, flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import type { ActivityHeadline } from "./chat-activity-headline-selection.ts";
import {
  ChatActivityHeadline,
  type ChatActivityHeadlineProps,
} from "./chat-activity-headline.solid.tsx";
import { createActivityGroupHarness } from "./chat-message-native.test-support.tsx";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultMessage,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";

let container: HTMLDivElement;
let activityRoot: ReturnType<typeof createActivityGroupHarness>;
let headlineRoot: ReturnType<typeof mountSolid> | undefined;
let updateHeadline: ((props: ChatActivityHeadlineProps) => void) | undefined;
let presentHeadline: ((active: boolean) => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  container = document.createElement("div");
  activityRoot = createActivityGroupHarness(container);
  headlineRoot = undefined;
  updateHeadline = undefined;
  presentHeadline = undefined;
});
afterEach(() => {
  headlineRoot?.unmount();
  activityRoot.unmount();
  container.remove();
  vi.useRealTimers();
});

async function renderActivityFixture(...args: Parameters<typeof activityRoot.render>) {
  if (!container.isConnected) {
    document.body.append(container);
  }
  activityRoot.render(...args);
  await settleToolBridges(container);
}

function advanceTimersByTime(ms: number) {
  vi.advanceTimersByTime(ms);
  flush();
}

function operation(key: string, status: ActivityHeadline["status"] = "running"): ActivityHeadline {
  return { key, title: "Read " + key, status };
}

function drawHeadline(props: ChatActivityHeadlineProps) {
  if (!updateHeadline) {
    headlineRoot = mountSolid(
      () => {
        const [current, setCurrent] = createSignal(props);
        const [active, setActive] = createSignal(true);
        updateHeadline = setCurrent;
        presentHeadline = setActive;
        return (
          <ContentPresentation value={active}>
            <button>
              <ChatActivityHeadline {...current()} />
            </button>
          </ContentPresentation>
        );
      },
      { container },
    );
  } else {
    updateHeadline(props);
    flush();
  }
  return {
    setConnected: (active: boolean) => {
      presentHeadline?.(active);
      flush();
    },
  };
}

function update(activity: ActivityHeadline | undefined, scope = "session:run") {
  return drawHeadline({ scope, activity, summary: "2 reads" });
}

function label() {
  return container.querySelector(".chat-activity-group__label")?.textContent;
}

describe("activity headline cadence", () => {
  it("holds new copy for three seconds and replaces pending work instead of replaying a backlog", () => {
    update(operation("first"));
    advanceTimersByTime(400);
    update(operation("discarded"));
    advanceTimersByTime(400);
    update(operation("latest"));
    advanceTimersByTime(2_199);
    expect(label()).toBe("Read first…");
    advanceTimersByTime(1);
    expect(label()).toBe("Read latest…");
    expect(vi.getTimerCount()).toBe(0);

    update(operation("next"));
    advanceTimersByTime(2_999);
    expect(label()).toBe("Read latest…");
    advanceTimersByTime(1);
    expect(label()).toBe("Read next…");
    advanceTimersByTime(30_000);
    expect(label()).toBe("Read next…");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps outcome labels with a held purpose and drops them beside the count", () => {
    const draw = (activity: ActivityHeadline) =>
      drawHeadline({
        scope: "session:run",
        activity,
        summary: "2 reads · 1 unknown",
        outcomes: ["1 unknown"],
      });
    const outcomes = () =>
      [...container.querySelectorAll(".chat-activity-group__outcome")].map(
        (node) => node.textContent,
      );
    draw(operation("first"));
    advanceTimersByTime(100);
    // A step with no title waits its turn; the purpose still on show keeps its label.
    draw({ ...operation("untitled"), title: "" });
    expect(label()).toBe("Read first…");
    expect(outcomes()).toEqual(["1 unknown"]);
    advanceTimersByTime(2_900);
    // The count line carries the outcome itself.
    expect(label()).toBe("2 reads · 1 unknown");
    expect(outcomes()).toEqual([]);
  });

  it("starts a fresh dwell when a new scope reuses the same operation identity", () => {
    update(operation("first"));
    advanceTimersByTime(2_000);
    update(operation("stale"));
    update(operation("first"), "new-scope");
    update(operation("next"), "new-scope");
    advanceTimersByTime(2_999);
    expect(label()).toBe("Read first…");
    advanceTimersByTime(1);
    expect(label()).toBe("Read next…");
  });

  it("cancels its timer while disconnected and resumes with only the latest pending operation", () => {
    const root = update(operation("first"));
    update(operation("pending"));
    expect(vi.getTimerCount()).toBe(1);
    root.setConnected(false);
    expect(vi.getTimerCount()).toBe(0);
    advanceTimersByTime(3_000);
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

it.each([
  {
    name: "exec",
    args: { title: "Update investigation progress", code: "return null" },
    phase: "start",
    expected: "Update investigation progress…",
  },
  {
    name: "web_search",
    args: { query: "new plugin APIs" },
    phase: "start",
    expected: 'for "new plugin APIs"…',
  },
  {
    name: "lookup_record",
    args: { query: "release notes" },
    phase: "start",
    expected: "release notes…",
  },
  {
    name: "exec",
    args: { title: "Inspect source", code: "return null" },
    phase: "result",
    status: "unknown",
    expected: "Outcome unknown",
  },
  // A step with no title of its own leaves the row reading as its count.
  { name: "session_status", phase: "result", isError: false, expected: "1 other operation" },
] as const)("renders accessible $name activity: $expected", async ({ expected, ...params }) => {
  const activity = projectAgentToolActivity({ toolCallId: "purpose", ...params });
  await renderActivityFixture([group("current", [activity])], liveOptions);
  const summary = container.querySelector<HTMLButtonElement>(".chat-activity-group__summary")!;
  const icon = summary.querySelector('.chat-activity-group__icon[role="img"]');
  expect(label()).toBe(expected);
  expect(icon?.getAttribute("aria-label")).toBe(params.name);
  expect(icon?.getAttribute("title")).toBe(params.name);
  expect(icon?.querySelector("svg")).not.toBeNull();
  if (params.phase === "start") {
    expect(summary.textContent?.trim()).toBe(expected);
  }
});

it("keeps the icon paired with the held purpose and restores the aggregate icon", async () => {
  const exec = projectAgentToolActivity({
    toolCallId: "exec",
    name: "exec",
    args: { title: "Inspect source", code: "return null" },
    phase: "start",
  });
  const search = projectAgentToolActivity({
    toolCallId: "search",
    name: "web_search",
    args: { query: "API docs" },
    phase: "start",
  });
  const draw = async (items: AgentActivityItem[], runActive = true) =>
    await renderActivityFixture([group("current", items)], { ...liveOptions, runActive });
  const icon = () => container.querySelector(".chat-activity-group__icon");
  await draw([exec]);
  expect(icon()?.getAttribute("aria-label")).toBe("exec");
  const execSvg = icon()?.innerHTML;
  advanceTimersByTime(100);
  await draw([exec, search]);
  expect(label()).toBe("Inspect source…");
  expect(icon()?.getAttribute("aria-label")).toBe("exec");
  advanceTimersByTime(2_900);
  await settleToolBridges(container);
  expect(label()).toBe('for "API docs"…');
  expect(icon()?.getAttribute("aria-label")).toBe("web_search");
  expect(icon()?.innerHTML).not.toBe(execSvg);
  await draw([exec, search], false);
  expect(label()).toBe("1 command · 1 search");
  expect(icon()?.getAttribute("aria-hidden")).toBe("true");
  expect(icon()?.getAttribute("aria-label")).toBeNull();
});

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
    activityRoot.render([group("current", activity)], {
      ...liveOptions,
      isToolMessageExpanded: () => expanded,
      onToggleToolMessageExpanded: onToggle,
    });
  draw([prepared("first")]);
  const summary = container.querySelector<HTMLButtonElement>(".chat-activity-group__summary")!;
  const body = container.querySelector<HTMLElement>(".chat-activity-group__body")!;
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(summary.getAttribute("aria-controls")).toBe(body.id);
  expect(body.hidden).toBe(true);
  summary.click();
  expect(onToggle).toHaveBeenCalledWith("activity:current", false);

  advanceTimersByTime(1_000);
  draw([prepared("first", "completed")]);
  expanded = true;
  draw([prepared("first", "completed"), prepared("next")]);
  expect(label()).toBe("Read first");
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  expect(body.hidden).toBe(false);
  expect(container.querySelector(".chat-activity-group__summary")).toBe(summary);
  advanceTimersByTime(1_999);
  expect(label()).toBe("Read first");
  advanceTimersByTime(1);
  expect(label()).toBe("Read next…");
  expanded = false;
  draw([prepared("first", "completed"), prepared("next", "completed")]);
  expect(label()).toBe("Read next");
  expect(summary.getAttribute("aria-expanded")).toBe("false");
});

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
  activityRoot.render(groups, { ...liveOptions, activityGroupKey: "current" });
  expect(label()).toBe("Read current…");
  activityRoot.render(groups, { ...liveOptions, activityGroupKey: "newer-group" });
  expect(label()).toBe("3 reads");
  activityRoot.render(groups, { ...liveOptions, activityRunId: "absent-run" });
  expect(label()).toBe("3 reads");
  advanceTimersByTime(3_000);
  expect(label()).toBe("3 reads");
});

it("uses the newest group's live card label without inheriting an earlier failure", async () => {
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

  await renderActivityFixture(groups, opts);
  const activitySummary = container.querySelector<HTMLButtonElement>(
    ".chat-activity-group__summary",
  )!;
  expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
  expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
  expect(activitySummary.getAttribute("aria-label")).toBeNull();
  expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
  expect(container.querySelector(".chat-activity-group__label")?.textContent).toBe(
    "in /repo/src/a.ts…",
  );

  await renderActivityFixture(groups, { ...opts, runActive: false });
  expect(activitySummary.textContent?.replace(/\s+/gu, " ").trim()).toBe(
    "1 read · 1 edit 1 failed",
  );
});

it.each(["failed", "blocked"] as const)(
  "preserves a nested child's %s urgency under its parent purpose",
  async (status) => {
    await renderActivityFixture([group("current", [prepared("first")])], liveOptions);
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
    await renderActivityFixture([nested], liveOptions);
    expect(label()).toBe("Build the snake game");
    expect(vi.getTimerCount()).toBe(0);
    expect(container.querySelector(".chat-activity-group__summary")?.textContent).toContain(
      "1 " + status,
    );
  },
);

it("keeps the live row for a step with a routine nested call until the run settles", async () => {
  const step = (status: AgentActivityItem["status"]) =>
    createToolGroup("current", [
      createMessageEntry(
        "step",
        createAssistantMessage(
          [
            createToolCall(
              "parent",
              "exec",
              { title: "Build the snake game", code: "// Build game" },
              { runId: "active-run" },
            ),
            createToolCall(
              "child",
              "progress_card",
              { plan: [] },
              { runId: "active-run", parentToolCallId: "parent" },
            ),
          ],
          {
            runId: "active-run",
            activity: [
              { ...prepared("parent", status), name: "exec", title: "Build the snake game" },
              { ...prepared("child", "completed"), hideFromChannelProgress: true },
            ],
          },
        ),
      ),
    ]);
  await renderActivityFixture([step("running")], liveOptions);
  expect(label()).toBe("Build the snake game…");
  // Finishing mid-run keeps the live row; only settlement swaps in the step's own row.
  await renderActivityFixture([step("completed")], liveOptions);
  expect(label()).toBe("Build the snake game");
  await renderActivityFixture([step("completed")], { ...liveOptions, runActive: false });
  expect(container.querySelector(".chat-activity-group__summary")).toBeNull();
  expect(container.querySelector(".chat-tool-row__title")?.textContent).toBe(
    "Build the snake game",
  );
});

it.each([false, true])(
  "refreshes a held operation when completion and the next start coexist (duplicate start: %s)",
  (duplicateStart) => {
    activityRoot.render([group("current", [prepared("first")])], liveOptions);
    advanceTimersByTime(200);
    const settled = [
      ...(duplicateStart ? [prepared("first")] : []),
      prepared("first", "completed"),
    ];
    if (duplicateStart) {
      activityRoot.render([group("current", settled)], liveOptions);
      expect(label()).toBe("Read first");
    }
    activityRoot.render([group("current", [...settled, prepared("next")])], liveOptions);
    expect(label()).toBe("Read first");
    advanceTimersByTime(2_800);
    expect(label()).toBe("Read next…");
  },
);
