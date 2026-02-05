import { describe, expect, it, vi } from "vitest";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

describe("agent event handler", () => {
  it("emits chat delta for assistant text-only events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => "session-1",
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    handler({
      runId: "run-tool",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t1" },
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    resetAgentRunContextForTest();
  });

  it("suppresses tool events when verbose is off", () => {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => "session-1",
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => "session-1",
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    handler({
      runId: "run-tool-on",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t3",
        result: { content: [{ type: "text", text: "secret" }] },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toBeUndefined();
    expect(payload.data?.partialResult).toBeUndefined();
    resetAgentRunContextForTest();
  });

  it("keeps tool output when verbose is full", () => {
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => "session-1",
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    const result = { content: [{ type: "text", text: "secret" }] };
    handler({
      runId: "run-tool-full",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "t4",
        result,
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { data?: Record<string, unknown> };
    expect(payload.data?.result).toEqual(result);
    resetAgentRunContextForTest();
  });
});
