import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createToolEventRecipientRegistry,
} from "./server-chat.js";

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));

vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

describe("agent event handler", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReturnValue({});
    vi.mocked(resolveHeartbeatVisibility).mockReturnValue({
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    });
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    resetAgentRunContextForTest();
  });

  function createHarness(params?: {
    now?: number;
    resolveSessionKeyForRun?: (runId: string) => string | undefined;
  }) {
    const nowSpy =
      params?.now === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(params.now);
    const broadcast = vi.fn();
    const broadcastToConnIds = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    const toolEventRecipients = createToolEventRecipientRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      handler,
    };
  }

  function emitRun1AssistantText(
    harness: ReturnType<typeof createHarness>,
    text: string,
  ): ReturnType<typeof createHarness> {
    harness.chatRunState.registry.add("run-1", {
      sessionKey: "session-1",
      clientRunId: "client-1",
    });
    harness.handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text },
    });
    return harness;
  }

  function chatBroadcastCalls(broadcast: ReturnType<typeof vi.fn>) {
    return broadcast.mock.calls.filter(([event]) => event === "chat");
  }

  function sessionChatCalls(nodeSendToSession: ReturnType<typeof vi.fn>) {
    return nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
  }

  const FALLBACK_LIFECYCLE_DATA = {
    phase: "fallback",
    selectedProvider: "fireworks",
    selectedModel: "fireworks/minimax-m2p5",
    activeProvider: "deepinfra",
    activeModel: "moonshotai/Kimi-K2.5",
  } as const;

  function emitLifecycleEnd(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 2,
  ) {
    handler({
      runId,
      seq,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });
  }

  function emitFallbackLifecycle(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq?: number;
    sessionKey?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq ?? 1,
      stream: "lifecycle",
      ts: Date.now(),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      data: { ...FALLBACK_LIFECYCLE_DATA },
    });
  }

  function expectSingleAgentBroadcastPayload(broadcast: ReturnType<typeof vi.fn>) {
    const broadcastAgentCalls = broadcast.mock.calls.filter(([event]) => event === "agent");
    expect(broadcastAgentCalls).toHaveLength(1);
    return broadcastAgentCalls[0]?.[1] as {
      runId?: string;
      sessionKey?: string;
      stream?: string;
      data?: Record<string, unknown>;
    };
  }

  function expectSingleFinalChatPayload(broadcast: ReturnType<typeof vi.fn>) {
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: unknown;
    };
    expect(payload.state).toBe("final");
    return payload;
  }

  it("emits chat delta for assistant text-only events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello world",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("strips inline directives from assistant chat events", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      "Hello [[reply_to_current]] world [[audio_as_voice]]",
    );
    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("Hello  world ");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("does not emit chat delta for NO_REPLY streaming text", () => {
    const { broadcast, nodeSendToSession, nowSpy } = emitRun1AssistantText(
      createHarness({ now: 1_000 }),
      " NO_REPLY  ",
    );
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
    nowSpy?.mockRestore();
  });

  it("does not include NO_REPLY text in chat final message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "NO_REPLY" },
    });
    emitLifecycleEnd(handler, "run-2");

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("cleans up agent run sequence tracking when lifecycle completes", () => {
    const { agentRunSeq, chatRunState, handler, nowSpy } = createHarness({ now: 2_500 });
    chatRunState.registry.add("run-cleanup", {
      sessionKey: "session-cleanup",
      clientRunId: "client-cleanup",
    });

    handler({
      runId: "run-cleanup",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    expect(agentRunSeq.get("run-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("routes tool events only to registered recipients when verbose is enabled", () => {
    const { broadcast, broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool", "conn-1");

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

  it("broadcasts tool events to WS recipients even when verbose is off, but skips node send", () => {
    const { broadcastToConnIds, nodeSendToSession, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-off", { sessionKey: "session-1", verboseLevel: "off" });
    toolEventRecipients.add("run-tool-off", "conn-1");

    handler({
      runId: "run-tool-off",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "t2" },
    });

    // Tool events always broadcast to registered WS recipients
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    // But node/channel subscribers should NOT receive when verbose is off
    const nodeToolCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeToolCalls).toHaveLength(0);
    resetAgentRunContextForTest();
  });

  it("strips tool output when verbose is on", () => {
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-on", { sessionKey: "session-1", verboseLevel: "on" });
    toolEventRecipients.add("run-tool-on", "conn-1");

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
    const { broadcastToConnIds, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-tool-full", { sessionKey: "session-1", verboseLevel: "full" });
    toolEventRecipients.add("run-tool-full", "conn-1");

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

  it("broadcasts fallback events to agent subscribers and node session", () => {
    const { broadcast, broadcastToConnIds, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback" });

    expect(broadcastToConnIds).not.toHaveBeenCalled();
    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");
    expect(payload.sessionKey).toBe("session-fallback");
    expect(payload.data?.activeProvider).toBe("deepinfra");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
  });

  it("remaps chat-linked lifecycle runId to client runId", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-fallback",
    });
    chatRunState.registry.add("run-fallback-internal", {
      sessionKey: "session-fallback",
      clientRunId: "run-fallback-client",
    });

    emitFallbackLifecycle({ handler, runId: "run-fallback-internal" });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.runId).toBe("run-fallback-client");
    expect(payload.stream).toBe("lifecycle");
    expect(payload.data?.phase).toBe("fallback");

    const nodeCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "agent");
    expect(nodeCalls).toHaveLength(1);
    const nodePayload = nodeCalls[0]?.[2] as { runId?: string };
    expect(nodePayload.runId).toBe("run-fallback-client");
  });

  it("uses agent event sessionKey when run-context lookup cannot resolve", () => {
    const { broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    emitFallbackLifecycle({
      handler,
      runId: "run-fallback-session-key",
      sessionKey: "session-from-event",
    });

    const payload = expectSingleAgentBroadcastPayload(broadcast);
    expect(payload.sessionKey).toBe("session-from-event");
  });

  it("remaps chat-linked tool runId for non-full verbose payloads", () => {
    const { broadcastToConnIds, chatRunState, toolEventRecipients, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-remap",
    });

    chatRunState.registry.add("run-tool-internal", {
      sessionKey: "session-tool-remap",
      clientRunId: "run-tool-client",
    });
    registerAgentRunContext("run-tool-internal", {
      sessionKey: "session-tool-remap",
      verboseLevel: "on",
    });
    toolEventRecipients.add("run-tool-internal", "conn-1");

    handler({
      runId: "run-tool-internal",
      seq: 1,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "tool-remap-1",
        result: { content: [{ type: "text", text: "secret" }] },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const payload = broadcastToConnIds.mock.calls[0]?.[1] as { runId?: string };
    expect(payload.runId).toBe("run-tool-client");
    resetAgentRunContextForTest();
  });

  it("suppresses heartbeat ack-like chat output when showOk is false", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness({
      now: 2_000,
    });
    chatRunState.registry.add("run-heartbeat", {
      sessionKey: "session-heartbeat",
      clientRunId: "client-heartbeat",
    });
    registerAgentRunContext("run-heartbeat", {
      sessionKey: "session-heartbeat",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      },
    });

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);

    emitLifecycleEnd(handler, "run-heartbeat");

    const finalPayload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(finalPayload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
  });

  it("keeps heartbeat alert text in final chat output when remainder exceeds ackMaxChars", () => {
    vi.mocked(loadConfig).mockReturnValue({
      agents: { defaults: { heartbeat: { ackMaxChars: 10 } } },
    });

    const { broadcast, chatRunState, handler } = createHarness({ now: 3_000 });
    chatRunState.registry.add("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      clientRunId: "client-heartbeat-alert",
    });
    registerAgentRunContext("run-heartbeat-alert", {
      sessionKey: "session-heartbeat-alert",
      isHeartbeat: true,
      verboseLevel: "off",
    });

    handler({
      runId: "run-heartbeat-alert",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: "HEARTBEAT_OK Disk usage crossed 95 percent on /data and needs cleanup now.",
      },
    });

    emitLifecycleEnd(handler, "run-heartbeat-alert");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe(
      "Disk usage crossed 95 percent on /data and needs cleanup now.",
    );
  });

  describe("tool-call message boundary text preservation (#28180)", () => {
    // Helper: emit assistant text, advancing time to bypass 150ms throttle.
    function emitAssistantText(params: {
      handler: ReturnType<typeof createHarness>["handler"];
      runId: string;
      seq: number;
      text: string;
      nowSpy: ReturnType<typeof vi.spyOn>;
      time: number;
    }) {
      params.nowSpy.mockReturnValue(params.time);
      params.handler({
        runId: params.runId,
        seq: params.seq,
        stream: "assistant",
        ts: params.time,
        data: { text: params.text },
      });
    }

    function lastDeltaText(broadcast: ReturnType<typeof vi.fn>): string | undefined {
      const deltas = chatBroadcastCalls(broadcast)
        .map(([, payload]) => payload as Record<string, unknown>)
        .filter((p) => p.state === "delta") as Array<{
        message?: { content?: Array<{ text?: string }> };
      }>;
      return deltas[deltas.length - 1]?.message?.content?.[0]?.text;
    }

    const PRE_TOOL_TEXT = "Lorem ipsum dolor sit amet, consectetur adipiscing elit.";
    const PRE_TOOL_GROWING = "Lorem ipsum dolor sit amet, consectetur adipiscing";

    it("preserves pre-tool text when post-tool text arrives from a new assistant message", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { broadcast, chatRunState, handler } = harness;
      chatRunState.registry.add("run-tool-boundary", {
        sessionKey: "session-1",
        clientRunId: "client-tool-boundary",
      });

      // Pre-tool text grows normally (same assistant message).
      emitAssistantText({
        handler,
        runId: "run-tool-boundary",
        seq: 1,
        text: PRE_TOOL_GROWING,
        nowSpy,
        time: 1_000,
      });
      expect(lastDeltaText(broadcast)).toBe(PRE_TOOL_GROWING);

      emitAssistantText({
        handler,
        runId: "run-tool-boundary",
        seq: 2,
        text: PRE_TOOL_TEXT,
        nowSpy,
        time: 1_200,
      });
      expect(lastDeltaText(broadcast)).toBe(PRE_TOOL_TEXT);

      // After tool call, the agent starts a new assistant message — text resets.
      emitAssistantText({
        handler,
        runId: "run-tool-boundary",
        seq: 3,
        text: "After tool call.",
        nowSpy,
        time: 5_000,
      });

      // The delta should include BOTH pre-tool and post-tool text.
      expect(lastDeltaText(broadcast)).toBe(`${PRE_TOOL_TEXT}\n\nAfter tool call.`);
      nowSpy.mockRestore();
    });

    it("preserves text across multiple tool-call boundaries", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { broadcast, chatRunState, handler } = harness;
      chatRunState.registry.add("run-multi-tool", {
        sessionKey: "session-1",
        clientRunId: "client-multi-tool",
      });

      // Simulate realistic streaming: each segment grows from short to long,
      // then after a tool call the next segment starts short again. The new
      // segment's initial delta must be shorter than (high-water - 32) to
      // trigger boundary detection.
      const seg1 =
        "Step one: a fairly long first message that exceeds the tolerance threshold with plenty of room to spare in the buffer.";
      const seg2 =
        "Step two: another long message after the first tool call that also exceeds the tolerance threshold substantially.";
      const seg3 = "Step three.";

      emitAssistantText({
        handler,
        runId: "run-multi-tool",
        seq: 1,
        text: seg1,
        nowSpy,
        time: 1_000,
      });
      expect(lastDeltaText(broadcast)).toBe(seg1);

      // After first tool call: seg2 starts as "S" (1 char << 118 - 32 = 86).
      emitAssistantText({
        handler,
        runId: "run-multi-tool",
        seq: 2,
        text: "S",
        nowSpy,
        time: 3_000,
      });
      expect(lastDeltaText(broadcast)).toBe(`${seg1}\n\nS`);

      // seg2 grows to full length.
      emitAssistantText({
        handler,
        runId: "run-multi-tool",
        seq: 3,
        text: seg2,
        nowSpy,
        time: 3_200,
      });
      expect(lastDeltaText(broadcast)).toBe(`${seg1}\n\n${seg2}`);

      // After second tool call: seg3 starts short again.
      emitAssistantText({
        handler,
        runId: "run-multi-tool",
        seq: 4,
        text: seg3,
        nowSpy,
        time: 5_000,
      });
      expect(lastDeltaText(broadcast)).toBe(`${seg1}\n\n${seg2}\n\n${seg3}`);

      nowSpy.mockRestore();
    });

    it("includes prior segments in the final chat event text", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { broadcast, chatRunState, handler } = harness;
      chatRunState.registry.add("run-final-segments", {
        sessionKey: "session-1",
        clientRunId: "client-final-segments",
      });

      emitAssistantText({
        handler,
        runId: "run-final-segments",
        seq: 1,
        text: PRE_TOOL_TEXT,
        nowSpy,
        time: 1_000,
      });

      emitAssistantText({
        handler,
        runId: "run-final-segments",
        seq: 2,
        text: "After tool.",
        nowSpy,
        time: 3_000,
      });

      // Lifecycle end triggers chat final.
      nowSpy.mockReturnValue(4_000);
      handler({
        runId: "run-final-segments",
        seq: 3,
        stream: "lifecycle",
        ts: 4_000,
        data: { phase: "end" },
      });

      const finalCalls = chatBroadcastCalls(broadcast)
        .map(([, payload]) => payload as Record<string, unknown>)
        .filter((p) => p.state === "final") as Array<{
        message?: { content?: Array<{ text?: string }> };
      }>;
      expect(finalCalls).toHaveLength(1);
      expect(finalCalls[0]?.message?.content?.[0]?.text).toBe(`${PRE_TOOL_TEXT}\n\nAfter tool.`);

      nowSpy.mockRestore();
    });

    it("does not create false boundary when text grows monotonically", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { broadcast, chatRunState, handler } = harness;
      chatRunState.registry.add("run-no-false-boundary", {
        sessionKey: "session-1",
        clientRunId: "client-no-false-boundary",
      });

      emitAssistantText({
        handler,
        runId: "run-no-false-boundary",
        seq: 1,
        text: "Hello",
        nowSpy,
        time: 1_000,
      });
      expect(lastDeltaText(broadcast)).toBe("Hello");

      emitAssistantText({
        handler,
        runId: "run-no-false-boundary",
        seq: 2,
        text: "Hello world",
        nowSpy,
        time: 1_200,
      });
      expect(lastDeltaText(broadcast)).toBe("Hello world");

      emitAssistantText({
        handler,
        runId: "run-no-false-boundary",
        seq: 3,
        text: "Hello world, how are you?",
        nowSpy,
        time: 1_400,
      });
      // No duplication — text grew normally.
      expect(lastDeltaText(broadcast)).toBe("Hello world, how are you?");

      nowSpy.mockRestore();
    });

    it("preserves short pre-tool text (no minimum length requirement)", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { broadcast, chatRunState, handler } = harness;
      chatRunState.registry.add("run-short", {
        sessionKey: "session-1",
        clientRunId: "client-short",
      });

      // Short pre-tool text (well under 32 chars).
      emitAssistantText({
        handler,
        runId: "run-short",
        seq: 1,
        text: "Sure, let me check.",
        nowSpy,
        time: 1_000,
      });
      expect(lastDeltaText(broadcast)).toBe("Sure, let me check.");

      // Post-tool text arrives — boundary must be detected even for short text.
      emitAssistantText({
        handler,
        runId: "run-short",
        seq: 2,
        text: "Here are the results.",
        nowSpy,
        time: 3_000,
      });
      expect(lastDeltaText(broadcast)).toBe("Sure, let me check.\n\nHere are the results.");

      nowSpy.mockRestore();
    });

    it("preserves pre-tool text even when post-tool text shares a common prefix", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { broadcast, chatRunState, handler } = harness;
      chatRunState.registry.add("run-shared-prefix", {
        sessionKey: "session-1",
        clientRunId: "client-shared-prefix",
      });

      // Pre-tool text.
      emitAssistantText({
        handler,
        runId: "run-shared-prefix",
        seq: 1,
        text: "Lorem ipsum dolor sit amet.",
        nowSpy,
        time: 1_000,
      });

      // Post-tool text starts streaming token by token — first delta is short
      // and doesn't start with the full pre-tool text, so boundary is detected
      // even though the eventual text will share a common prefix.
      emitAssistantText({
        handler,
        runId: "run-shared-prefix",
        seq: 2,
        text: "Lorem",
        nowSpy,
        time: 3_000,
      });
      expect(lastDeltaText(broadcast)).toBe("Lorem ipsum dolor sit amet.\n\nLorem");

      // Post-tool text continues growing.
      emitAssistantText({
        handler,
        runId: "run-shared-prefix",
        seq: 3,
        text: "Lorem ipsum dolor sit amet, with new content.",
        nowSpy,
        time: 3_200,
      });
      expect(lastDeltaText(broadcast)).toBe(
        "Lorem ipsum dolor sit amet.\n\nLorem ipsum dolor sit amet, with new content.",
      );

      nowSpy.mockRestore();
    });

    it("cleans up priorSegments on abort", () => {
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const harness = createHarness({ now: 1_000 });
      const { chatRunState, handler } = harness;
      chatRunState.registry.add("run-abort-cleanup", {
        sessionKey: "session-1",
        clientRunId: "client-abort-cleanup",
      });

      emitAssistantText({
        handler,
        runId: "run-abort-cleanup",
        seq: 1,
        text: PRE_TOOL_TEXT,
        nowSpy,
        time: 1_000,
      });

      // New message boundary — text shrinks well below high-water mark.
      emitAssistantText({
        handler,
        runId: "run-abort-cleanup",
        seq: 2,
        text: "After tool.",
        nowSpy,
        time: 3_000,
      });
      expect(chatRunState.priorSegments.has("client-abort-cleanup")).toBe(true);

      // Mark aborted and send lifecycle end.
      chatRunState.abortedRuns.set("client-abort-cleanup", Date.now());
      nowSpy.mockReturnValue(4_000);
      handler({
        runId: "run-abort-cleanup",
        seq: 3,
        stream: "lifecycle",
        ts: 4_000,
        data: { phase: "end" },
      });

      // priorSegments should be cleaned up.
      expect(chatRunState.priorSegments.has("client-abort-cleanup")).toBe(false);
      nowSpy.mockRestore();
    });
  });
});
