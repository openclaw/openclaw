import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../api/gateway.ts";
import {
  createSidebarNarration,
  type SidebarNarration,
} from "../components/app-sidebar-session-narration.ts";
import type { SidebarToolActivity } from "../components/app-sidebar-session-types.ts";
import { runningRow } from "./app-sidebar-session-narration.ts";

const narrations: SidebarNarration[] = [];
function gatewayEvent(event: string, payload: unknown): GatewayEventFrame {
  return { type: "event", event, payload };
}
function chatDelta(text?: string, deltaText?: string, replace?: boolean): GatewayEventFrame {
  return gatewayEvent("chat", {
    sessionKey: "agent:main:run",
    runId: "run-1",
    state: "delta",
    deltaText,
    replace,
    ...(text === undefined ? {} : { message: { role: "assistant", content: text } }),
  });
}

const toolItem = (data: Record<string, unknown>): Record<string, unknown> => ({
  kind: "tool",
  name: "read",
  title: "Read",
  phase: "update",
  ...data,
});

function createToolNarration(defaultRunId = "run-1") {
  const tools: Array<ReadonlyMap<string, SidebarToolActivity>> = [];
  const source = {
    subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
    unsubscribeMessages: vi.fn(() => Promise.resolve()),
  };
  const narration = createSidebarNarration();
  narration.subscribe(() => {
    const next = narration.read().tools;
    if (next !== tools.at(-1)) {
      tools.push(next);
    }
  });
  narrations.push(narration);
  narration.sync({
    enabled: true,
    connected: true,
    connectionIdentity: {},
    source,
    openSessionKey: "",
    rows: [runningRow("agent:main:run")],
    agentId: "main",
  });
  const emit = (stream: string, data: Record<string, unknown>, runId = defaultRunId) =>
    narration.handleEvent(
      gatewayEvent("session.tool", { sessionKey: "agent:main:run", runId, stream, data }),
    );
  const emitItem = (
    itemId: string,
    data: Record<string, unknown>,
    runId = "run-2",
    stream = "item",
  ) => emit(stream, toolItem({ itemId, ...data }), runId);
  return { narration, tools, source, emit, emitItem };
}
it("keeps tool identity separate from commentary and clears it with its run", async () => {
  const { narration, source, emit } = createToolNarration();
  await Promise.resolve();

  narration.handleEvent(chatDelta("**Reading** files.", "**Reading** files."));
  emit("tool", { phase: "start", name: "read" });

  expect(narration.read().lines.get("agent:main:run")).toBe("Reading files.");
  await vi.advanceTimersByTimeAsync(1_999);
  expect(narration.read().lines.get("agent:main:run")).toBe("Reading files.");
  await vi.advanceTimersByTimeAsync(1);
  expect(narration.read().lines.get("agent:main:run")).toBe("Reading files.");
  expect(narration.read().tools.get("agent:main:run")?.name).toBe("read");

  narration.handleEvent(chatDelta("", undefined, true));
  expect(narration.read().lines.size).toBe(0);
  expect(narration.read().tools.get("agent:main:run")?.name).toBe("read");

  narration.handleEvent(
    gatewayEvent("chat", {
      sessionKey: "agent:main:run",
      runId: "run-2",
      state: "delta",
      message: { role: "assistant", content: "A new run" },
    }),
  );
  expect(narration.read().tools.size).toBe(0);
  emit("tool", { name: "plugin.custom_tool" }, "run-2");
  expect(narration.read().tools.get("agent:main:run")?.name).toBe("plugin.custom_tool");

  narration.disconnect();
  expect(source.unsubscribeMessages).toHaveBeenCalledWith({
    key: "agent:main:run",
    agentId: null,
  });
  expect(narration.read().lines.size).toBe(0);
  expect(narration.read().tools.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

beforeEach(() => {
  vi.useFakeTimers({ now: 10_000 });
});
afterEach(() => {
  for (const narration of narrations.splice(0)) {
    narration.disconnect();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("projects public tool progress without exposing raw output or unrelated items", () => {
  const { narration, tools, emit, emitItem } = createToolNarration();
  const call = { name: "exec", toolCallId: "call-1" };
  const item = { ...call, kind: "tool", itemId: "tool:call-1" };
  emit("tool", {
    ...call,
    phase: "start",
    args: { command: "private input" },
  });
  expect(tools.at(-1)?.get("agent:main:run")).toEqual({
    name: "exec",
    toolCallId: "call-1",
    text: undefined,
  });
  emit("item", {
    ...item,
    phase: "start",
    title: "Exec printf fixture-private-output",
    meta: "printf fixture-private-output",
  });
  expect(tools.at(-1)?.get("agent:main:run")?.text).toBeUndefined();
  emit("item", {
    ...item,
    phase: "update",
    title: "Exec",
    meta: "Run focused tests",
    progressText: "Checking **3 files**",
  });
  expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Checking 3 files");
  emit("tool", {
    ...call,
    phase: "update",
    partialResult: { text: "private output" },
  });
  expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Checking 3 files");
  const count = tools.length;
  emit("item", {
    kind: "preamble",
    itemId: "preamble",
    phase: "end",
    title: "Preamble",
    progressText: "Unrelated narration",
  });
  emitItem("hidden", { hideFromChannelProgress: true }, "run-1");
  expect(tools).toHaveLength(count);
  emit("tool", { name: "exec", toolCallId: "call-2", phase: "start" });
  expect(tools.at(-1)?.get("agent:main:run")?.text).toBeUndefined();
  narration.disconnect();
  expect(tools.at(-1)?.size).toBe(0);
});

it.each([
  { stream: "item", flag: "hideFromChannelProgress", metadata: "full" },
  { stream: "item", flag: "suppressChannelProgress", metadata: "full" },
  { stream: "tool", flag: "hideFromChannelProgress", metadata: "full" },
  { stream: "tool", flag: "hideFromChannelProgress", metadata: "omitted" },
  { stream: "tool", flag: "hideFromChannelProgress", metadata: "contradictory" },
])(
  "withdraws matching $stream progress with $metadata metadata when $flag changes",
  ({ stream, flag, metadata }) => {
    const { tools, emit: emitTool } = createToolNarration();
    const emit = (
      runId: string,
      toolCallId: string,
      data: Record<string, unknown>,
      eventStream = "item",
    ) => {
      const payload = toolItem({
        itemId: "tool:" + toolCallId,
        toolCallId,
        ...data,
      });
      if (eventStream === "tool" && metadata === "omitted") {
        delete payload.name;
        delete payload.phase;
      } else if (eventStream === "tool" && metadata === "contradictory") {
        payload.name = "other-tool";
      }
      emitTool(eventStream, payload, runId);
    };
    emit("run-2", "current", { progressText: "Public progress" });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public progress");
    const visibleCount = tools.length;
    emit("run-1", "current", { [flag]: true }, stream);
    emit("run-2", "other", { [flag]: true }, stream);
    emit("", "current", { [flag]: true }, stream);
    expect(tools).toHaveLength(visibleCount);
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public progress");
    emit("run-2", "current", { [flag]: true }, stream);
    expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
    expect(tools).toHaveLength(visibleCount + 1);
    emit("run-2", "current", { [flag]: true }, stream);
    expect(tools).toHaveLength(visibleCount + 1);
  },
);

it.each([
  { flag: "hideFromChannelProgress", toolCallId: undefined },
  { flag: "suppressChannelProgress", toolCallId: undefined },
  { flag: "hideFromChannelProgress", toolCallId: "" },
  { flag: "suppressChannelProgress", toolCallId: "" },
])("withdraws the matching item with $flag and call ID $toolCallId", ({ flag, toolCallId }) => {
  const { tools, emitItem } = createToolNarration();
  const emit = (itemId: string, runId: string, data: Record<string, unknown>, stream = "item") =>
    emitItem(itemId, { toolCallId, ...data }, runId, stream);
  emit("current-item", "run-2", { progressText: "Public item progress" });
  expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public item progress");
  const count = tools.length;
  emit("other-item", "run-2", { [flag]: true });
  emit("current-item", "run-old", { [flag]: true });
  emit("current-item", "", { [flag]: true });
  // A raw call ID is not an item ID, even when their strings happen to match.
  emit("current-item", "run-2", { toolCallId: "current-item", [flag]: true }, "tool");
  expect(tools).toHaveLength(count);
  emit("current-item", "run-2", { [flag]: true });
  expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
  expect(tools).toHaveLength(count + 1);
});

it.each([
  { toolCallId: undefined, flag: "hideFromChannelProgress" },
  { toolCallId: "shared-call", flag: "hideFromChannelProgress" },
  { toolCallId: "shared-call", flag: "suppressChannelProgress" },
])("keeps replacement item identity with call ID $toolCallId and $flag", ({ toolCallId, flag }) => {
  const { tools, emitItem } = createToolNarration();
  const emit = (itemId: string, hidden = false) =>
    emitItem(itemId, { toolCallId, progressText: "Public progress", [flag]: hidden });
  emit("old-item");
  emit("new-item");
  emit("old-item", true);
  expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public progress");
  emit("new-item", true);
  expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
});

it("retains prepared item and call identity across matching item and raw-tool frames", () => {
  const { tools, emit } = createToolNarration("run-2");
  const item = toolItem({ itemId: "item" });
  emit("item", { ...item, toolCallId: "call", progressText: "Public progress" });
  emit("tool", { name: "read", toolCallId: "call", phase: "update" });
  const count = tools.length;
  emit("item", { ...item, toolCallId: "other-call", hideFromChannelProgress: true });
  expect(tools).toHaveLength(count);
  emit("item", { ...item, hideFromChannelProgress: true });
  expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
  emit("item", { ...item, toolCallId: "call", progressText: "Public progress" });
  emit("item", { ...item, progressText: "New public progress" });
  emit("tool", { toolCallId: "call", hideFromChannelProgress: true });
  expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
});

it.each(["tool", "item"])("retains the identified tool name after a %s start", (stream) => {
  const { tools, emit } = createToolNarration("run-2");
  const toolCallId = stream === "tool" ? "call" : undefined;
  const item = { kind: "tool", itemId: "known-item", title: "Read", phase: "update", toolCallId };
  emit(stream, {
    ...item,
    phase: "start",
    name: "read",
    progressText: "Earlier public progress",
  });
  const count = tools.length;
  emit("item", {
    ...item,
    itemId: "other-item",
    toolCallId: undefined,
    progressText: "Unrelated unnamed progress",
  });
  expect(tools).toHaveLength(count);
  emit("item", { ...item, progressText: "Updated public progress" });
  expect(tools.at(-1)?.get("agent:main:run")).toMatchObject({
    name: "read",
    text: "Updated public progress",
  });
});
