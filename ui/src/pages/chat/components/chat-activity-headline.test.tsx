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

function expectAfter(ms: number, expected: string) {
  advanceTimersByTime(ms);
  expect(label()).toBe(expected);
}

function toolActivity(
  name: string,
  args: Record<string, unknown>,
  isError = false,
  toolCallId = name,
) {
  return projectAgentToolActivity({
    toolCallId,
    name,
    args,
    phase: isError ? "result" : "start",
    isError,
  });
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
  return query("label")?.textContent;
}

function query(part: string) {
  return container.querySelector<HTMLElement>(`.chat-activity-group__${part}`);
}

describe("activity headline cadence", () => {
  it("holds new copy for three seconds and replaces pending work instead of replaying a backlog", () => {
    update(operation("first"));
    advanceTimersByTime(400);
    update(operation("discarded"));
    advanceTimersByTime(400);
    update(operation("latest"));
    expectAfter(2_199, "Read first…");
    expectAfter(1, "Read latest…");
    expect(vi.getTimerCount()).toBe(0);

    update(operation("next"));
    expectAfter(2_999, "Read latest…");
    expectAfter(1, "Read next…");
    expectAfter(30_000, "Read next…");
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
    draw({ ...operation("untitled"), title: "" });
    expect(label()).toBe("Read first…");
    expect(outcomes()).toEqual(["1 unknown"]);
    expectAfter(2_900, "2 reads · 1 unknown");
    expect(outcomes()).toEqual([]);
  });

  it("starts a fresh dwell when a new scope reuses the same operation identity", () => {
    update(operation("first"));
    advanceTimersByTime(2_000);
    update(operation("stale"));
    update(operation("first"), "new-scope");
    update(operation("next"), "new-scope");
    expectAfter(2_999, "Read first…");
    expectAfter(1, "Read next…");
  });

  it("cancels its timer while disconnected and resumes with only the latest pending operation", () => {
    const root = update(operation("first"));
    update(operation("pending"));
    expect(vi.getTimerCount()).toBe(1);
    root.setConnected(false);
    expect(vi.getTimerCount()).toBe(0);
    expectAfter(3_000, "Read first…");
    root.setConnected(true);
    expect(label()).toBe("Read pending…");
    expect(vi.getTimerCount()).toBe(0);
  });
});

function entryGroup(
  key: string,
  message: Record<string, unknown>,
  options?: Parameters<typeof createToolGroup>[2],
) {
  return createToolGroup(key, [createMessageEntry(key + ":entry", message)], options);
}

function group(key: string, activity: AgentActivityItem[], runId = "active-run") {
  return entryGroup(
    key,
    createAssistantMessage(
      activity.map((item) =>
        createToolCall(item.toolCallId!, item.name!, { path: "/repo/file.ts" }),
      ),
      { runId, activity },
    ),
  );
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

function nestedStep(childName: string, parent: AgentActivityItem, child: AgentActivityItem) {
  const runId = "active-run";
  return entryGroup(
    "current",
    createAssistantMessage(
      [
        createToolCall("parent", "exec", { title: parent.title, code: "// Build game" }, { runId }),
        createToolCall(
          "child",
          childName,
          childName === "write" ? { path: "index.html" } : { plan: [] },
          { runId, parentToolCallId: "parent" },
        ),
      ],
      { runId, activity: [parent, child] },
    ),
  );
}

it.each([
  ["exec", { title: "Inspect", code: "return null" }, "start", "Inspect…"],
  ["web_search", { query: "new plugin APIs" }, "start", 'for "new plugin APIs"…'],
  ["lookup_record", { query: "release notes" }, "start", "release notes…"],
  ["exec", { title: "Inspect source", code: "return null" }, "result", "Inspect source"],
  ["exec", {}, "result", "Exec"],
  ["session_status", {}, "result", "1 other operation"],
] as const)("renders accessible %s activity", async (name, args, phase, expected) => {
  const activity = projectAgentToolActivity({
    toolCallId: "purpose",
    name,
    args,
    phase,
    ...(name === "session_status"
      ? { isError: false }
      : phase === "result"
        ? { status: "unknown" }
        : {}),
  });
  await renderActivityFixture([group("current", [activity])], liveOptions);
  const summary = query("summary")!;
  const icon = summary.querySelector('.chat-activity-group__icon[role="img"]');
  expect(label()).toBe(expected);
  expect(icon?.getAttribute("aria-label")).toBe(name);
  expect(icon?.hasAttribute("title")).toBe(false);
  expect(icon?.querySelector("svg")).not.toBeNull();
  if (phase === "start") {
    expect(summary.textContent?.trim()).toBe(expected);
  }
});

it("keeps the icon paired with the held purpose and restores the aggregate icon", async () => {
  const exec = toolActivity("exec", { title: "Inspect source", code: "return null" });
  const search = toolActivity("web_search", { query: "API docs" });
  const draw = async (items: AgentActivityItem[], runActive = true) =>
    await renderActivityFixture([group("current", items)], { ...liveOptions, runActive });
  const icon = () => query("icon");
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
  const summary = query("summary")!;
  const body = query("body")!;
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
  expect(query("summary")).toBe(summary);
  expectAfter(1_999, "Read first");
  expectAfter(1, "Read next…");
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
  expectAfter(3_000, "3 reads");
});

it("uses the newest group's live card label without inheriting an earlier failure", async () => {
  const groups = [
    entryGroup(
      "live-first",
      createToolResultMessage("call-read", "read", JSON.stringify({ error: "failed" }), {
        isError: true,
        runId: "active-run",
        activity: [toolActivity("read", {}, true, "call-read")],
      }),
    ),
    entryGroup(
      "live-second",
      {
        role: "assistant",
        runId: "active-run",
        activity: [toolActivity("edit", { path: "/repo/src/a.ts" }, false, "call-edit")],
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
      },
      { isStreaming: true },
    ),
  ];
  const opts = { ...liveOptions, showReasoning: true };

  await renderActivityFixture(groups, opts);
  const activitySummary = query("summary")!;
  expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
  expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
  expect(activitySummary.getAttribute("aria-label")).toBeNull();
  expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
  expect(label()).toBe("in /repo/src/a.ts…");

  await renderActivityFixture(groups, { ...opts, runActive: false });
  expect(activitySummary.textContent?.replace(/\s+/gu, " ").trim()).toBe("1 read · 1 edit");
});

it.each(["failed", "blocked"] as const)(
  "preserves a nested child's %s urgency under its parent purpose",
  async (status) => {
    await renderActivityFixture([group("current", [prepared("first")])], liveOptions);
    const parent = { ...prepared("parent"), name: "exec", title: "Build the snake game" };
    const nested = nestedStep("write", parent, prepared("child", status));
    await renderActivityFixture([nested], liveOptions);
    expect(label()).toBe("Build the snake game");
    expect(vi.getTimerCount()).toBe(0);
    // A reviewer's block is a decision worth surfacing; a failed attempt mid-run is not.
    const summary = query("summary")?.textContent;
    if (status === "blocked") {
      expect(summary).toContain("1 blocked");
    } else {
      expect(summary).not.toContain("failed");
    }
  },
);

it("keeps the live row for a step with a routine nested call until the run settles", async () => {
  const step = (status: AgentActivityItem["status"]) =>
    nestedStep(
      "progress_card",
      { ...prepared("parent", status), name: "exec", title: "Build the snake game" },
      { ...prepared("child", "completed"), hideFromChannelProgress: true },
    );
  await renderActivityFixture([step("running")], liveOptions);
  expect(label()).toBe("Build the snake game…");
  await renderActivityFixture([step("completed")], liveOptions);
  expect(label()).toBe("Build the snake game");
  await renderActivityFixture([step("completed")], { ...liveOptions, runActive: false });
  expect(query("summary")).toBeNull();
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
    expectAfter(2_800, "Read next…");
  },
);
