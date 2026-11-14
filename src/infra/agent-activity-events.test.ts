import { expect, expectTypeOf, onTestFinished, test } from "vitest";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  emitAgentActivityEvent,
  projectAgentHistoryActivity,
  projectAgentToolActivity,
} from "./agent-activity-events.js";
import {
  type AgentApprovalEventData,
  type AgentEventPayload,
  onAgentEvent,
  resetAgentEventsForTest,
} from "./agent-events.js";

type HistoryMessage = { messageId: string; message: unknown };

function nestedEntry(
  messageId: string,
  overrides: Partial<Parameters<typeof createNestedToolActivity>[0]>,
) {
  return {
    messageId,
    message: createNestedToolActivity({
      runId: "run",
      scopeId: "scope",
      afterEntryId: "wrapper",
      startOrder: 1,
      toolCallId: messageId,
      toolName: "read",
      input: {},
      result: { content: [] },
      isError: false,
      startedAt: 1,
      timestamp: 2,
      ...overrides,
    }),
  };
}

function call(messageId: string, id: string | undefined, metadata = {}, name = "exec", args = {}) {
  return {
    messageId,
    message: {
      role: "assistant",
      ...metadata,
      content: [{ type: "toolCall", id, name, arguments: args }],
    },
  };
}

function toolResult<T extends string | undefined>(toolCallId: T, toolName = "exec", metadata = {}) {
  return { role: "toolResult", toolCallId, toolName, isError: false, ...metadata };
}

function resultEntry(messageId: string, toolCallId: string | undefined, metadata = {}) {
  return { messageId, message: toolResult(toolCallId, "exec", metadata) };
}

test("forwards activity data with sequencing and optional session context", () => {
  type ItemData = Extract<Parameters<typeof emitAgentActivityEvent>[0], { stream: "item" }>["data"];
  expectTypeOf<AgentApprovalEventData>().not.toMatchTypeOf<ItemData>();

  const context = { runId: "run-1", sessionKey: "session-1" };
  const item = { itemId: "item-1", title: "Read", toolCallId: "tool-1" };
  const inputs: Parameters<typeof emitAgentActivityEvent>[0][] = [
    {
      ...context,
      stream: "item",
      data: { ...item, phase: "start", kind: "tool", status: "running" },
    },
    {
      ...context,
      sessionKey: "",
      stream: "patch",
      data: {
        ...item,
        phase: "end",
        added: ["new.ts"],
        modified: [],
        deleted: [],
        summary: "Added new.ts",
      },
    },
  ];
  resetAgentEventsForTest();
  onTestFinished(() => resetAgentEventsForTest());
  const events: AgentEventPayload[] = [];
  onTestFinished(onAgentEvent((event) => events.push(event)));
  for (const input of inputs) {
    emitAgentActivityEvent(input);
  }
  expect(
    events.map(({ runId, seq, stream, sessionKey }) => [runId, seq, stream, sessionKey]),
  ).toEqual([
    ["run-1", 1, "item", "session-1"],
    ["run-1", 2, "patch", undefined],
  ]);
  expect(events.map((event) => event.data)).toEqual(inputs.map((input) => input.data));
  expect(events[0]?.data).toBe(inputs[0]?.data);
});

test("projects Tool Search names for live and history activity without changing outcomes or pairing", () => {
  const args = { id: "openclaw:core:exec", args: { command: "check-release" } };
  const tool = { toolCallId: "release-check", name: "tool_call", args };
  expect(projectAgentToolActivity({ ...tool, phase: "start" })).toMatchObject({
    name: "exec",
    toolCallId: tool.toolCallId,
    status: "running",
    commandBearing: true,
  });
  const result = toolResult(tool.toolCallId, tool.name, {
    details: { status: "completed", exitCode: 2 },
  });
  // Presentation must not reinterpret the dispatcher's result as a native exec result.
  expect(
    projectAgentToolActivity({ ...tool, phase: "result", result, isError: false }),
  ).toMatchObject({ name: "exec", status: "completed" });

  const skipped = {
    ...result,
    details: { status: "skipped", deniedReason: "steering" },
    isError: true,
  };
  const history = projectAgentHistoryActivity([
    call("call", tool.toolCallId, {}, tool.name, args),
    { messageId: "result", message: skipped },
  ]);
  for (const entry of history) {
    expect(entry.items).toMatchObject([
      {
        name: "exec",
        title: "Exec check-release",
        toolCallId: tool.toolCallId,
        status: "skipped",
        commandBearing: true,
      },
    ]);
    expect(entry.items[0]?.meta).toBe("check-release");
  }
});

test("derives historical Tool Search metadata from the executed inner input", () => {
  const projected = projectAgentHistoryActivity([
    nestedEntry("child", {
      toolCallId: "search-read",
      toolName: "tool_call",
      input: { id: "read", args: { path: "notes/release.md" } },
    }),
  ]);
  expect(projected[0]?.items).toMatchObject([{ name: "read", toolCallId: "search-read" }]);
  expect(projected[0]?.items[0]?.meta).toContain("release.md");
});

test.each([
  { details: { status: "skipped", deniedReason: "steering" }, status: "skipped" },
  { details: { status: "skipped", deniedReason: "other" }, status: "blocked" },
  { details: { status: "approval-pending" }, status: "blocked" },
  { details: { status: "approval-unavailable" }, status: "blocked" },
  { details: { status: "error" }, status: "failed" },
])("preserves $details as $status in live and history activity", ({ details, status }) => {
  const result = toolResult("read-context", "read", { details, isError: true });
  const live = projectAgentToolActivity({
    toolCallId: result.toolCallId,
    name: result.toolName,
    phase: "result",
    result,
    isError: true,
  });
  const history = projectAgentHistoryActivity([{ messageId: "result", message: result }]);
  expect(live.status).toBe(status);
  expect(history[0]?.items).toMatchObject([{ status }]);
});

test.each([
  { outcome: "completed", hidden: true },
  { outcome: "failed", hidden: false },
  { outcome: "execution-failed", hidden: false },
  { outcome: "blocked", hidden: false },
  { outcome: "missing", hidden: false },
  { outcome: "unlinked", hidden: false },
  { outcome: "other-run", hidden: false },
  { outcome: "no-run", hidden: false },
  { outcome: "duplicate", hidden: false },
  { outcome: "result-only", hidden: true },
  { outcome: "no-call-id", hidden: false },
])("keeps recorded child failures with a $outcome wrapper", ({ outcome, hidden }) => {
  const runId = outcome === "other-run" ? "other" : outcome === "no-run" ? undefined : "run";
  const wrapper = call("wrapper", outcome === "no-call-id" ? undefined : "outer", {
    __openclaw: { runId },
  });
  const messages: HistoryMessage[] = outcome === "result-only" ? [] : [wrapper];
  if (outcome === "duplicate") {
    messages.push({ ...wrapper, messageId: "duplicate-wrapper" });
  }
  messages.push(
    nestedEntry("child", {
      ...(outcome === "unlinked" ? {} : { parentToolCallId: "outer" }),
      isError: true,
    }),
  );
  if (outcome !== "missing") {
    messages.push(
      resultEntry("wrapper-result", outcome === "no-call-id" ? undefined : "outer", {
        __openclaw: { runId },
        isError: outcome === "failed",
        ...(outcome === "blocked" ? { details: { status: "approval-pending" } } : {}),
        ...(outcome === "execution-failed" ? { details: { status: "failed" } } : {}),
      }),
    );
  }
  const projected = projectAgentHistoryActivity(messages);
  expect(projected.find((entry) => entry.messageId === "child")?.items).toMatchObject([
    { toolCallId: "child", status: "failed" },
  ]);
  const outer = projected.find(
    (entry) => entry.messageId === (outcome === "result-only" ? "wrapper-result" : "wrapper"),
  )?.items;
  expect(outer).toMatchObject(hidden ? [] : [{ name: "exec" }]);
  if (outcome === "execution-failed") {
    expect(outer).toMatchObject([{ status: "failed" }]);
  }
});

test("keeps a completed step countable when its only child is routine progress", () => {
  const projected = projectAgentHistoryActivity([
    call("step", "step", { runId: "run" }, "exec", {
      title: "Check the release checklist",
      code: "await tools.progress_card({});",
    }),
    nestedEntry("progress", {
      afterEntryId: "step",
      parentToolCallId: "step",
      toolName: "progress_card",
      input: { action: "update", title: "Release checklist" },
    }),
    resultEntry("result", "step", { runId: "run" }),
  ]);
  expect(projected.find((entry) => entry.messageId === "step")?.items).toMatchObject([
    { toolCallId: "step", name: "exec", status: "completed" },
  ]);
  expect(projected.find((entry) => entry.messageId === "progress")?.items).toEqual([]);
});

test.each([
  {
    nested: [
      ["inner", "exec", "outer"],
      ["plan", "progress_card", "inner"],
    ] as const,
    counted: "inner",
  },
  {
    nested: [
      ["plan", "progress_card", "outer"],
      ["read", "read", "plan"],
    ] as const,
    counted: "read",
  },
])("counts only $counted through nested hidden progress", ({ nested, counted }) => {
  const projected = projectAgentHistoryActivity([
    call("outer", "outer", { __openclaw: { runId: "run" } }),
    ...nested.map(([id, name, parent], index) =>
      nestedEntry(id, {
        afterEntryId: "outer-call",
        startOrder: index + 1,
        parentToolCallId: parent,
        toolName: name,
      }),
    ),
    resultEntry("outer-result", "outer", { __openclaw: { runId: "run" } }),
  ]);
  expect(
    projected.flatMap((entry) => entry.items.map((item) => [entry.messageId, item.toolCallId])),
  ).toEqual([[counted, counted]]);
});

test.each([true, false])("does not expose a child assignment in progress (named: %s)", (named) => {
  const item = projectAgentToolActivity({
    toolCallId: "spawn-worker",
    name: "sessions_spawn",
    phase: "start",
    args: {
      ...(named ? { label: "Maple", taskName: "verify-release" } : {}),
      task: "PRIVATE_CHILD_ASSIGNMENT: inspect an internal document and report its contents",
    },
  });
  if (named) {
    expect(`${item.title} ${item.meta ?? ""}`).toContain("Maple");
  }
  expect(JSON.stringify(item)).not.toContain("PRIVATE_CHILD_ASSIGNMENT");
});
test("marks only unpaired history calls as provisional, including terminal unknown outcomes", () => {
  const unpaired = call("call", "command");
  const missing = projectAgentHistoryActivity([unpaired])[0]?.items[0];
  expect(missing).toMatchObject({ phase: "end", unpairedCall: true });
  expect(missing).not.toHaveProperty("summary");
  expect(missing?.status).toBeUndefined();
  const result = resultEntry("result", "command", {
    details: {
      status: "completed",
      exitCode: 143,
      persistedDetailsTruncated: true,
      originalDetailKeys: ["exitReason"],
    },
  });
  for (const entry of projectAgentHistoryActivity([unpaired, result])) {
    expect(entry.items[0]).toMatchObject({ phase: "end", summary: "Outcome unknown" });
    expect(entry.items[0]?.status).toBeUndefined();
    expect(entry.items[0]).not.toHaveProperty("unpairedCall");
  }
});
