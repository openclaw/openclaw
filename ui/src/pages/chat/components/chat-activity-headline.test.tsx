/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { projectAgentToolActivity } from "../../../../../src/infra/agent-activity-events.js";
import { inlineCommandPresentation } from "../chat-inline-command-presentation.ts";
import { createActivityGroupHarness } from "./chat-message-native.test-support.tsx";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultMessage,
} from "./chat-message.test-support.ts";
import { settleToolBridges } from "./chat-tool-render.test-support.ts";
import { projectTranscriptActivity } from "./chat-transcript-activity.ts";

let container: HTMLDivElement;
let activityRoot: ReturnType<typeof createActivityGroupHarness>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  container = document.createElement("div");
  activityRoot = createActivityGroupHarness(container);
});
afterEach(() => {
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

function label() {
  return query("label")?.textContent;
}

function query(part: string) {
  return container.querySelector<HTMLElement>(`.chat-activity-group__${part}`);
}

function entryGroup(
  key: string,
  message: Record<string, unknown>,
  options?: Parameters<typeof createToolGroup>[2],
) {
  return createToolGroup(key, [createMessageEntry(key + ":entry", message)], options);
}

function group(
  key: string,
  activity: AgentActivityItem[],
  runId = "active-run",
  args?: Record<string, unknown>,
) {
  return entryGroup(
    key,
    createAssistantMessage(
      activity.map((item) =>
        createToolCall(
          item.toolCallId!,
          item.name!,
          args ?? { path: `/repo/${item.toolCallId}.ts` },
        ),
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
  ["exec", { title: "Inspect", code: "return null" }, "start", "Inspect"],
  ["web_search", { query: "new plugin APIs" }, "start", 'Web Search for "new plugin APIs"'],
  ["lookup_record", { query: "release notes" }, "start", "Lookup Record release notes"],
  ["exec", { title: "Inspect source", code: "return null" }, "result", "Inspect source"],
  ["exec", {}, "result", "Script execution"],
  ["session_status", {}, "result", "Session Status"],
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
  await renderActivityFixture([group("current", [activity], "active-run", args)], liveOptions);
  advanceTimersByTime(200);
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

it("shows a command once when its live activity group is expanded", async () => {
  const command = "pnpm test transcript";
  const activity = toolActivity("exec", { command });
  await renderActivityFixture([group("current", [activity], "active-run", { command })], {
    ...liveOptions,
    isToolMessageExpanded: () => true,
  });
  expect(query("summary")?.textContent).not.toContain(command);
  expect(container.textContent?.split(command)).toHaveLength(2);
});

it("keeps the icon paired with the current action and restores the aggregate icon", async () => {
  const exec = toolActivity("exec", { title: "Inspect source", code: "return null" });
  const search = toolActivity("web_search", { query: "API docs" });
  const args = { code: "return null", query: "API docs" };
  const draw = async (items: AgentActivityItem[], runActive = true) =>
    await renderActivityFixture([group("current", items, "active-run", args)], {
      ...liveOptions,
      runActive,
    });
  const icon = () => query("icon");
  await draw([exec]);
  advanceTimersByTime(200);
  expect(icon()?.getAttribute("aria-label")).toBe("exec");
  advanceTimersByTime(100);
  await draw([exec, search]);
  await settleToolBridges(container);
  expect(icon()?.getAttribute("aria-label")).toBe("exec");
  advanceTimersByTime(900);
  expect(label()).toBe('Web Search for "API docs"');
  expect(icon()?.getAttribute("aria-label")).toBe("web_search");
  await draw([exec, search], false);
  expect(label()).toBe("Running commands, searching");
  expect(icon()?.getAttribute("aria-hidden")).toBe("true");
  expect(icon()?.getAttribute("aria-label")).toBeNull();
});

const liveOptions = {
  showToolCalls: true,
  showReasoning: false,
  runActive: true,
  activityRunId: "active-run",
};

it("preserves a pending headline deadline when inline presentation splits and rejoins work", async () => {
  const inline = await inlineCommandPresentation();
  const first = { ...prepared("write-a"), name: "write" };
  const second = { ...prepared("write-b"), name: "write" };
  const draw = (includeSecond: boolean, inlineCommands: boolean) =>
    renderActivityFixture(
      [
        group("command", [{ ...prepared("command", "completed"), name: "exec" }], "active-run", {
          command: "printf ready",
        }),
        group(
          "writes",
          includeSecond ? [{ ...first, status: "completed", phase: "end" }, second] : [first],
        ),
      ],
      { ...liveOptions, inlineCommands: inlineCommands ? inline : undefined },
    );
  await draw(false, false);
  expectAfter(200, "Writing write-a.ts");
  advanceTimersByTime(100);
  await draw(true, false);
  expect(label()).toBe("Wrote write-a.ts");
  advanceTimersByTime(150);
  await draw(true, true);
  expect(query("summary")?.closest<HTMLElement>(".chat-activity-group")?.hidden).toBe(false);
  expectAfter(749, "Wrote write-a.ts");
  expectAfter(1, "Writing write-b.ts");
});

it("keeps accessible disclosure identity while the current action advances", () => {
  let expanded = false;
  const onToggle = vi.fn();
  const draw = (activity: AgentActivityItem[]) =>
    activityRoot.render([group("current", activity)], {
      ...liveOptions,
      isToolMessageExpanded: () => expanded,
      onToggleToolMessageExpanded: onToggle,
    });
  draw([prepared("first")]);
  advanceTimersByTime(200);
  const [summary, body, headline] = [query("summary")!, query("body")!, query("label")!];
  expect(summary.getAttribute("aria-expanded")).toBe("false");
  expect(summary.getAttribute("aria-controls")).toBe(body.id);
  expect(body.hidden).toBe(true);
  summary.click();
  expect(onToggle).toHaveBeenCalledWith("activity:current", false);

  advanceTimersByTime(1_000);
  draw([prepared("first", "completed")]);
  expanded = true;
  draw([prepared("first", "completed"), prepared("next")]);
  expect(label()).toBe("Reading files");
  expect(summary.getAttribute("aria-expanded")).toBe("true");
  expect(body.hidden).toBe(false);
  expect(query("label")).toBe(headline);
  expanded = false;
  draw([prepared("first", "completed"), prepared("next", "completed")]);
  expect(label()).toBe("Read next.ts");
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
  advanceTimersByTime(200);
  expect(label()).toBe("Reading current.ts");
  activityRoot.render(groups, { ...liveOptions, activityGroupKey: "newer-group" });
  expect(label()).toBe("Reading files");
  activityRoot.render(groups, { ...liveOptions, activityRunId: "absent-run" });
  expect(label()).toBe("Reading files");
  expectAfter(3_000, "Reading files");
});

it("settles an earlier activity headline only when narration follows in the same live run", () => {
  const activity = group("current", [prepared("current")]);
  const runId = "active-run";
  const user = (key: string, extra?: Record<string, unknown>) =>
    createToolGroup(key, [createMessageEntry(key, { role: "user", content: key, ...extra })], {
      role: "user",
    });
  const steer = user("steer", { __openclaw: { idempotencyKey: "steer", steerTargetRunId: runId } });
  const indicator = { kind: "reading-indicator" as const, key: "working", startedAt: 1, runId };
  const narration = {
    ...indicator,
    kind: "stream" as const,
    key: "n",
    text: "Next.",
    isStreaming: true,
  };
  const project = (items: Parameters<typeof projectTranscriptActivity>[0]) =>
    projectTranscriptActivity(items, { runId, runActive: true });
  // Steer receipts, the working indicator and queued messages leave the operation live.
  const pending = project([activity, steer, indicator, user("queued")]);
  expect(pending.activityGroupKey).toBe("current");
  activityRoot.render([activity], { ...liveOptions, ...pending });
  advanceTimersByTime(200);
  expect(container.querySelector(".text-shimmer")).not.toBeNull();
  const after = project([activity, steer, narration]);
  expect(after.activityGroupKey).toBeNull();
  activityRoot.render([activity], { ...liveOptions, ...after });
  expect(container.querySelector(".text-shimmer")).toBeNull();
  expect(label()).toBe("Reading files");
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
  advanceTimersByTime(200);
  const activitySummary = query("summary")!;
  expect(container.querySelector(".chat-activity-group.is-open")).toBeNull();
  expect(activitySummary.getAttribute("aria-expanded")).toBe("false");
  expect(activitySummary.getAttribute("aria-label")).toBeNull();
  expect(activitySummary.classList.contains("chat-activity-group__summary--error")).toBe(false);
  expect(label()).toBe("Editing a.ts");

  await renderActivityFixture(groups, { ...opts, runActive: false });
  expect(activitySummary.textContent?.replace(/\s+/gu, " ").trim()).toBe(
    "File reads, changing files",
  );
});

it.each(["failed", "blocked"] as const)(
  "preserves a nested child's %s action and urgency",
  async (status) => {
    await renderActivityFixture([group("current", [prepared("first")])], liveOptions);
    advanceTimersByTime(200);
    const parent = { ...prepared("parent"), name: "exec", title: "Executed code" };
    const nested = nestedStep("write", parent, prepared("child", status));
    await renderActivityFixture([nested], liveOptions);
    expect(label()).toBe("Write index.html");
    // Failures and reviewer blocks remain distinguishable while other work continues.
    const summary = query("summary")?.textContent;
    if (status === "blocked") {
      expect(summary).toContain("Blocked");
    } else {
      expect(summary).toContain("failed");
    }
  },
);

it("gates newly mounted live groups without hiding durable or urgent activity", async () => {
  const liveGroup = () => container.querySelector<HTMLElement>(".chat-activity-group");
  await renderActivityFixture([group("current", [prepared("durable")])], liveOptions);
  expect(liveGroup()?.hidden).toBe(true);
  advanceTimersByTime(199);
  expect(liveGroup()?.hidden).toBe(true);
  advanceTimersByTime(1);
  expect(liveGroup()?.hidden).toBe(false);
  expect(label()).toBe("Reading durable.ts");

  activityRoot.unmount();
  activityRoot = createActivityGroupHarness(container);
  await renderActivityFixture([group("urgent", [prepared("urgent", "failed")])], liveOptions);
  expect(liveGroup()?.hidden).toBe(false);
  expect(query("summary")?.textContent).toContain("failed");

  activityRoot.unmount();
  activityRoot = createActivityGroupHarness(container);
  const burst = [prepared("first")];
  activityRoot.render([group("burst", burst)], liveOptions);
  for (let index = 1; index <= 24; index++) {
    advanceTimersByTime(40);
    burst[burst.length - 1] = { ...burst.at(-1)!, status: "completed", phase: "end" };
    burst.push(prepared(`next-${index}`));
    activityRoot.render([group("burst", [...burst])], liveOptions);
    expect(liveGroup()?.hidden).toBe(true);
  }
  advanceTimersByTime(40);
  expect(liveGroup()?.hidden).toBe(false);
  expect(label()).toBe("Reading next-24.ts");
});

it("keeps routine-only execution containers hidden throughout the run", async () => {
  const step = (status: AgentActivityItem["status"]) =>
    nestedStep(
      "progress_card",
      { ...prepared("parent", status), name: "exec", title: "Executed code" },
      { ...prepared("child", "completed"), hideFromChannelProgress: true },
    );
  await renderActivityFixture([step("running")], liveOptions);
  expect(query("summary")).toBeNull();
  await renderActivityFixture([step("completed")], { ...liveOptions, runActive: false });
  expect(query("summary")).toBeNull();
  expect(container.querySelector(".chat-tool-row__title")).toBeNull();
});

it.each([false, true])(
  "refreshes a held operation when completion and the next start coexist (duplicate start: %s)",
  (duplicateStart) => {
    activityRoot.render([group("current", [prepared("first")])], liveOptions);
    advanceTimersByTime(200); // Initial presentation has settled.
    advanceTimersByTime(200);
    const settled = [
      ...(duplicateStart ? [prepared("first")] : []),
      prepared("first", "completed"),
    ];
    if (duplicateStart) {
      activityRoot.render([group("current", settled)], liveOptions);
      expect(label()).toBe("Read first.ts");
    }
    activityRoot.render([group("current", [...settled, prepared("next")])], liveOptions);
    expect(container.querySelector(".text-shimmer")).toBeNull();
    expectAfter(799, "Read first.ts");
    advanceTimersByTime(1);
    expect(container.querySelector(".text-shimmer")?.textContent).toBe("Reading next.ts");
  },
);

it("coalesces fast completed calls without replaying a queue or delaying their outcomes", () => {
  const items = [prepared("first")];
  const draw = () => activityRoot.render([group("current", items)], liveOptions);
  draw();
  advanceTimersByTime(200);
  advanceTimersByTime(20);
  items[0] = prepared("first", "completed");
  draw();
  for (let index = 1; index <= 30; index++) {
    advanceTimersByTime(20);
    items.push(prepared(`fast-${index}`, "completed"));
    draw();
    expect(label()).toBe("Read first.ts");
  }
  advanceTimersByTime(380);
  expect(label()).toBe("Read fast-30.ts");
  // A continuous burst must still advance; waiting for a quiet gap would starve it.
  for (let index = 31; index <= 52; index++) {
    advanceTimersByTime(50);
    items.push(prepared(`fast-${index}`, "completed"));
    draw();
  }
  expect(label()).not.toBe("Read fast-30.ts");
  expect(container.querySelector(".text-shimmer")).toBeNull();
  advanceTimersByTime(20);
  items.push(prepared("blocked", "blocked"));
  draw();
  expect(label()).toBe("Read blocked.ts");
  expect(query("summary")?.textContent).toContain("Blocked");
});

it("keeps an expanded execution's disclosure and live label between child commands", () => {
  const draw = (parentStatus: AgentActivityItem["status"], second = false) => {
    const exec = (key: string, status?: AgentActivityItem["status"]) => ({
      ...prepared(key, status),
      name: "exec",
    });
    const children = [exec("first", "completed"), ...(second ? [exec("second")] : [])];
    const calls = children.map((child) =>
      createToolCall(
        child.toolCallId!,
        "exec",
        { command: `printf ${child.toolCallId}` },
        { runId: "active-run", parentToolCallId: "parent" },
      ),
    );
    const parent = createToolCall("parent", "exec", { code: "await first(); await second();" });
    const activity = [exec("parent", parentStatus), ...children];
    activityRoot.render(
      [
        entryGroup(
          "current",
          createAssistantMessage([parent, ...calls], { runId: "active-run", activity }),
        ),
      ],
      { ...liveOptions, isToolMessageExpanded: () => true },
    );
    flush();
  };
  draw("running");
  const disclosure = query("summary");
  draw("running", true);
  expect(query("summary")).toBe(disclosure);
  expect(label()).toBe("Running commands");
  draw("completed");
  expect(query("summary")).toBe(disclosure);
  expect(label()).toBe("Ran commands");
});
