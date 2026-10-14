import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { SidebarSessionNarrationController } from "../components/app-sidebar-session-narration.ts";
import type { SidebarToolActivity } from "../components/app-sidebar-session-types.ts";
import { runningRow } from "./app-sidebar-session-narration.ts";

const controllers: SidebarSessionNarrationController[] = [];
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

function createToolController() {
  const tools: Array<ReadonlyMap<string, SidebarToolActivity>> = [];
  const source = {
    subscribeMessages: vi.fn(() => Promise.resolve({ key: "agent:main:run", agentId: null })),
    unsubscribeMessages: vi.fn(() => Promise.resolve()),
  };
  const controller = new SidebarSessionNarrationController(
    () => undefined,
    undefined,
    (next) => tools.push(next),
  );
  controllers.push(controller);
  controller.sync({
    enabled: true,
    connected: true,
    connectionIdentity: {},
    source,
    openSessionKey: "",
    rows: [runningRow("agent:main:run")],
    agentId: "main",
  });
  return { controller, tools };
}
describe("Sidebar tool activity", () => {
  it("keeps tool identity separate from commentary and clears it with its run", async () => {
    const subscribeMessages = vi.fn(() =>
      Promise.resolve({ key: "agent:main:run", agentId: null }),
    );
    const unsubscribeMessages = vi.fn(() => Promise.resolve());
    const source = { subscribeMessages, unsubscribeMessages };
    const updates: Array<ReadonlyMap<string, string>> = [];
    const tools: Array<ReadonlyMap<string, SidebarToolActivity>> = [];
    const controller = new SidebarSessionNarrationController(
      (lines) => updates.push(lines),
      undefined,
      (next) => tools.push(next),
    );
    const connectionIdentity = {};
    controller.sync({
      enabled: true,
      connected: true,
      connectionIdentity,
      source,
      openSessionKey: "",
      rows: [runningRow("agent:main:run")],
      agentId: "main",
    });
    await Promise.resolve();

    controller.handleEvent(chatDelta("**Reading** files.", "**Reading** files."));
    controller.handleEvent(
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-1",
        stream: "tool",
        data: { phase: "start", name: "read" },
      }),
    );

    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading files.");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading files.");
    await vi.advanceTimersByTimeAsync(1);
    expect(updates.at(-1)?.get("agent:main:run")).toBe("Reading files.");
    expect(tools.at(-1)?.get("agent:main:run")?.name).toBe("read");

    controller.handleEvent(chatDelta("", undefined, true));
    expect(updates.at(-1)?.size).toBe(0);
    expect(tools.at(-1)?.get("agent:main:run")?.name).toBe("read");

    controller.handleEvent(
      gatewayEvent("chat", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        state: "delta",
        message: { role: "assistant", content: "A new run" },
      }),
    );
    expect(tools.at(-1)?.size).toBe(0);
    controller.handleEvent(
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        stream: "tool",
        data: { name: "plugin.custom_tool" },
      }),
    );
    expect(tools.at(-1)?.get("agent:main:run")?.name).toBe("plugin.custom_tool");

    controller.disconnect();
    expect(unsubscribeMessages).toHaveBeenCalledWith({
      key: "agent:main:run",
      agentId: null,
    });
    expect(updates.at(-1)?.size).toBe(0);
    expect(tools.at(-1)?.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.disconnect();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("projects public tool progress without exposing raw output or unrelated items", () => {
    const { controller, tools } = createToolController();
    const emit = (stream: string, data: Record<string, unknown>) =>
      controller.handleEvent(
        gatewayEvent("session.tool", {
          sessionKey: "agent:main:run",
          runId: "run-1",
          stream,
          data,
        }),
      );
    emit("tool", {
      name: "exec",
      toolCallId: "call-1",
      phase: "start",
      args: { command: "private input" },
    });
    expect(tools.at(-1)?.get("agent:main:run")).toEqual({
      name: "exec",
      toolCallId: "call-1",
      text: undefined,
    });
    emit("item", {
      kind: "tool",
      itemId: "tool:call-1",
      name: "exec",
      toolCallId: "call-1",
      phase: "start",
      title: "Exec printf fixture-private-output",
      meta: "printf fixture-private-output",
    });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBeUndefined();
    emit("item", {
      kind: "tool",
      itemId: "tool:call-1",
      name: "exec",
      toolCallId: "call-1",
      phase: "update",
      title: "Exec",
      meta: "Run focused tests",
      progressText: "Checking **3 files**",
    });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Checking 3 files");
    emit("tool", {
      name: "exec",
      toolCallId: "call-1",
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
    emit("item", {
      kind: "tool",
      itemId: "hidden",
      name: "read",
      phase: "update",
      title: "Read",
      hideFromChannelProgress: true,
    });
    expect(tools).toHaveLength(count);
    emit("tool", { name: "exec", toolCallId: "call-2", phase: "start" });
    expect(tools.at(-1)?.get("agent:main:run")?.text).toBeUndefined();
    controller.disconnect();
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
      const { controller, tools } = createToolController();
      const emit = (
        runId: string,
        toolCallId: string,
        data: Record<string, unknown>,
        eventStream = "item",
      ) => {
        const payload: Record<string, unknown> = {
          kind: "tool",
          itemId: "tool:" + toolCallId,
          name: "read",
          toolCallId,
          phase: "update",
          title: "Read",
          ...data,
        };
        if (eventStream === "tool" && metadata === "omitted") {
          delete payload.name;
          delete payload.phase;
        } else if (eventStream === "tool" && metadata === "contradictory") {
          payload.name = "other-tool";
        }
        controller.handleEvent(
          gatewayEvent("session.tool", {
            sessionKey: "agent:main:run",
            runId,
            stream: eventStream,
            data: payload,
          }),
        );
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
      controller.disconnect();
    },
  );

  it.each([
    { flag: "hideFromChannelProgress", toolCallId: undefined },
    { flag: "suppressChannelProgress", toolCallId: undefined },
    { flag: "hideFromChannelProgress", toolCallId: "" },
    { flag: "suppressChannelProgress", toolCallId: "" },
  ])("withdraws the matching item with $flag and call ID $toolCallId", ({ flag, toolCallId }) => {
    const { controller, tools } = createToolController();
    const emit = (itemId: string, runId: string, data: Record<string, unknown>, stream = "item") =>
      controller.handleEvent(
        gatewayEvent("session.tool", {
          sessionKey: "agent:main:run",
          runId,
          stream,
          data: {
            kind: "tool",
            itemId,
            name: "read",
            title: "Read",
            phase: "update",
            toolCallId,
            ...data,
          },
        }),
      );
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
  ])(
    "keeps replacement item identity with call ID $toolCallId and $flag",
    ({ toolCallId, flag }) => {
      const { controller, tools } = createToolController();
      const emit = (itemId: string, hidden = false) =>
        controller.handleEvent(
          gatewayEvent("session.tool", {
            sessionKey: "agent:main:run",
            runId: "run-2",
            stream: "item",
            data: {
              kind: "tool",
              itemId,
              name: "read",
              title: "Read",
              phase: "update",
              toolCallId,
              progressText: "Public progress",
              [flag]: hidden,
            },
          }),
        );
      emit("old-item");
      emit("new-item");
      emit("old-item", true);
      expect(tools.at(-1)?.get("agent:main:run")?.text).toBe("Public progress");
      emit("new-item", true);
      expect(tools.at(-1)?.has("agent:main:run")).toBe(false);
    },
  );

  it("retains prepared item and call identity across matching item and raw-tool frames", () => {
    const { controller, tools } = createToolController();
    const emit = (stream: string, data: Record<string, unknown>) =>
      controller.handleEvent(
        gatewayEvent("session.tool", {
          sessionKey: "agent:main:run",
          runId: "run-2",
          stream,
          data,
        }),
      );
    const item = { kind: "tool", itemId: "item", name: "read", title: "Read", phase: "update" };
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
    const { controller, tools } = createToolController();
    const toolCallId = stream === "tool" ? "call" : undefined;
    const item = { kind: "tool", itemId: "known-item", title: "Read", phase: "update", toolCallId };
    controller.handleEvent(
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        stream,
        data: { ...item, phase: "start", name: "read", progressText: "Earlier public progress" },
      }),
    );
    const count = tools.length;
    controller.handleEvent(
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        stream: "item",
        data: {
          ...item,
          itemId: "other-item",
          toolCallId: undefined,
          progressText: "Unrelated unnamed progress",
        },
      }),
    );
    expect(tools).toHaveLength(count);
    controller.handleEvent(
      gatewayEvent("session.tool", {
        sessionKey: "agent:main:run",
        runId: "run-2",
        stream: "item",
        data: { ...item, progressText: "Updated public progress" },
      }),
    );
    expect(tools.at(-1)?.get("agent:main:run")).toMatchObject({
      name: "read",
      text: "Updated public progress",
    });
  });
});
