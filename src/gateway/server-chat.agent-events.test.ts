import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { resolveHeartbeatVisibility } from "../infra/heartbeat-visibility.js";

const persistGatewaySessionLifecycleEventMock = vi.fn();

vi.mock("./session-lifecycle-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-lifecycle-state.js")>();
  return {
    ...actual,
    persistGatewaySessionLifecycleEvent: (...args: unknown[]) =>
      persistGatewaySessionLifecycleEventMock(...args),
  };
});

import { abortChatRunById } from "./chat-abort.js";
import {
  clearEffectiveChatRunState,
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
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
    persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
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
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();

    const handler = createAgentEventHandler({
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: params?.resolveSessionKeyForRun ?? (() => undefined),
      clearAgentRunContext: vi.fn(),
      toolEventRecipients,
      sessionEventSubscribers,
    });

    return {
      nowSpy,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      toolEventRecipients,
      sessionEventSubscribers,
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

  function emitLifecycleStart(
    handler: ReturnType<typeof createHarness>["handler"],
    runId: string,
    seq = 1,
  ) {
    handler({
      runId,
      seq,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "start" },
    });
  }

  function emitAssistantText(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq: number;
    text: string;
    delta?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq,
      stream: "assistant",
      ts: Date.now(),
      data: {
        text: params.text,
        ...(params.delta === undefined ? {} : { delta: params.delta }),
      },
    });
  }

  function emitToolStart(params: {
    handler: ReturnType<typeof createHarness>["handler"];
    runId: string;
    seq: number;
    name?: string;
    toolCallId?: string;
  }) {
    params.handler({
      runId: params.runId,
      seq: params.seq,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "start",
        name: params.name ?? "read",
        toolCallId: params.toolCallId ?? `tool-${String(params.seq)}`,
      },
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

  it("ignores an initial assistant text + delta event when delta is not the full first chunk", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 1_000,
    });
    chatRunState.registry.add("run-ambiguous-first", {
      sessionKey: "session-ambiguous-first",
      clientRunId: "client-ambiguous-first",
    });

    emitAssistantText({
      handler,
      runId: "run-ambiguous-first",
      seq: 1,
      text: "Hello world",
      delta: " world",
    });

    expect(chatRunState.buffers.has("client-ambiguous-first")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-ambiguous-first")).toBe(false);
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(0);
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

  it("suppresses NO_REPLY lead fragments and does not leak NO in final chat message", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_100,
    });
    chatRunState.registry.add("run-3", { sessionKey: "session-3", clientRunId: "client-3" });

    let seq = 1;
    for (const text of ["NO", "NO_", "NO_RE", "NO_REPLY"]) {
      handler({
        runId: "run-3",
        seq,
        stream: "assistant",
        ts: Date.now(),
        data: { text },
      });
      seq += 1;
    }
    emitLifecycleEnd(handler, "run-3", seq);

    const payload = expectSingleFinalChatPayload(broadcast) as { message?: unknown };
    expect(payload.message).toBeUndefined();
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("keeps final short replies like 'No' even when lead-fragment deltas are suppressed", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_200,
    });
    chatRunState.registry.add("run-4", { sessionKey: "session-4", clientRunId: "client-4" });

    handler({
      runId: "run-4",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "No" },
    });
    emitLifecycleEnd(handler, "run-4");

    const payload = expectSingleFinalChatPayload(broadcast) as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.message?.content?.[0]?.text).toBe("No");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(1);
    nowSpy?.mockRestore();
  });

  it("flushes buffered text as delta before final when throttle suppresses the latest chunk", () => {
    let now = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-flush", {
      sessionKey: "session-flush",
      clientRunId: "client-flush",
    });

    handler({
      runId: "run-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello" },
    });

    now = 10_100;
    handler({
      runId: "run-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    emitLifecycleEnd(handler, "run-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const firstPayload = chatCalls[0]?.[1] as { state?: string };
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const thirdPayload = chatCalls[2]?.[1] as { state?: string };
    expect(firstPayload.state).toBe("delta");
    expect(secondPayload.state).toBe("delta");
    expect(secondPayload.message?.content?.[0]?.text).toBe("Hello world");
    expect(thirdPayload.state).toBe("final");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("flushes a same-length corrective snapshot before tool start after throttle suppression", () => {
    let now = 10_250;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const {
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      chatRunState,
      toolEventRecipients,
      handler,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-same-length-correction",
    });

    chatRunState.registry.add("run-same-length-correction", {
      sessionKey: "session-same-length-correction",
      clientRunId: "client-same-length-correction",
    });
    registerAgentRunContext("run-same-length-correction", {
      sessionKey: "session-same-length-correction",
      verboseLevel: "off",
    });
    toolEventRecipients.add("run-same-length-correction", "conn-1");

    handler({
      runId: "run-same-length-correction",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    now = 10_320;
    handler({
      runId: "run-same-length-correction",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello there" },
    });

    now = 10_500;
    handler({
      runId: "run-same-length-correction",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: {
        phase: "start",
        name: "read",
        toolCallId: "tool-same-length-correction",
      },
    });

    emitLifecycleEnd(handler, "run-same-length-correction", 4);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const payloadTexts = chatCalls
      .map(
        ([, payload]) =>
          payload as { state?: string; message?: { content?: Array<{ text?: string }> } },
      )
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world", "Hello there", "Hello there"]);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    expect(broadcastToConnIds).toHaveBeenCalled();
    nowSpy.mockRestore();
  });

  it("drops ambiguous non-prefix assistant chunks instead of appending them", () => {
    let now = 10_500;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented", {
      sessionKey: "session-segmented",
      clientRunId: "client-segmented",
    });

    handler({
      runId: "run-segmented",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool call", delta: "Before tool call" },
    });

    now = 10_700;
    handler({
      runId: "run-segmented",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "After tool call", delta: "\nAfter tool call" },
    });

    emitLifecycleEnd(handler, "run-segmented", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const finalPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("does not flush ambiguous non-prefix assistant chunks before final", () => {
    let now = 10_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-segmented-flush", {
      sessionKey: "session-segmented-flush",
      clientRunId: "client-segmented-flush",
    });

    handler({
      runId: "run-segmented-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool call", delta: "Before tool call" },
    });

    now = 10_860;
    handler({
      runId: "run-segmented-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "After tool call", delta: "\nAfter tool call" },
    });

    emitLifecycleEnd(handler, "run-segmented-flush", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const finalPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Before tool call");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("does not flush an extra delta when the latest text already broadcast", () => {
    let now = 11_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-no-dup-flush", {
      sessionKey: "session-no-dup-flush",
      clientRunId: "client-no-dup-flush",
    });

    handler({
      runId: "run-no-dup-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello" },
    });

    now = 11_200;
    handler({
      runId: "run-no-dup-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    emitLifecycleEnd(handler, "run-no-dup-flush");

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    expect(chatCalls.map(([, payload]) => (payload as { state?: string }).state)).toEqual([
      "delta",
      "delta",
      "final",
    ]);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("ignores duplicate seq replay instead of regrowing the visible buffer", () => {
    let now = 11_300;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-replay", {
      sessionKey: "session-replay",
      clientRunId: "client-replay",
    });

    emitAssistantText({
      handler,
      runId: "run-replay",
      seq: 1,
      text: "Hello",
    });

    now = 11_500;
    emitAssistantText({
      handler,
      runId: "run-replay",
      seq: 1,
      text: "HelloHello",
    });

    emitLifecycleEnd(handler, "run-replay", 2);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const finalPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Hello");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);
    nowSpy.mockRestore();
  });

  it("replaces with a non-prefix full snapshot instead of appending it", () => {
    let now = 11_700;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-replace", {
      sessionKey: "session-replace",
      clientRunId: "client-replace",
    });

    emitAssistantText({
      handler,
      runId: "run-replace",
      seq: 1,
      text: "Draft answer",
    });

    now = 11_900;
    emitAssistantText({
      handler,
      runId: "run-replace",
      seq: 2,
      text: "Final rewritten answer",
    });

    emitLifecycleEnd(handler, "run-replace", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const secondPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(secondPayload.message?.content?.[0]?.text).toBe("Final rewritten answer");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Final rewritten answer");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it("enters recovery on seq gap and ignores ordinary assistant deltas until a full replacement arrives", () => {
    let now = 12_100;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-gap", {
      sessionKey: "session-gap",
      clientRunId: "client-gap",
    });

    emitAssistantText({
      handler,
      runId: "run-gap",
      seq: 1,
      text: "Hello",
    });
    expect(chatRunState.waitingForRecovery.has("client-gap")).toBe(false);

    now = 12_300;
    emitAssistantText({
      handler,
      runId: "run-gap",
      seq: 3,
      text: "",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-gap")).toBe(true);
    expect(chatRunState.buffers.get("client-gap")).toBe("Hello");

    now = 12_500;
    emitAssistantText({
      handler,
      runId: "run-gap",
      seq: 4,
      text: "",
      delta: "!",
    });
    expect(chatRunState.buffers.get("client-gap")).toBe("Hello");

    emitLifecycleEnd(handler, "run-gap", 5);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const finalPayload = chatCalls[1]?.[1] as {
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.message?.content?.[0]?.text).toBe("Hello");
    nowSpy.mockRestore();
  });

  it("does not shrink the buffer on an ordinary shorter full snapshot merge", () => {
    let now = 12_550;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-no-shrink", {
      sessionKey: "session-no-shrink",
      clientRunId: "client-no-shrink",
    });

    emitAssistantText({
      handler,
      runId: "run-no-shrink",
      seq: 1,
      text: "Hello world",
    });

    now = 12_750;
    emitAssistantText({
      handler,
      runId: "run-no-shrink",
      seq: 2,
      text: "Hello",
    });

    expect(chatRunState.buffers.get("client-no-shrink")).toBe("Hello world");

    emitLifecycleEnd(handler, "run-no-shrink", 3);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world", "Hello world"]);
    nowSpy.mockRestore();
  });

  it("does not advance lastAcceptedSeq for ignored in-order snapshots, so same-seq replay can still recover", () => {
    let now = 12_575;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-replay-after-ignore", {
      sessionKey: "session-replay-after-ignore",
      clientRunId: "client-replay-after-ignore",
    });

    emitAssistantText({
      handler,
      runId: "run-replay-after-ignore",
      seq: 1,
      text: "Hello world",
    });
    expect(chatRunState.lastAcceptedSeq.get("client-replay-after-ignore")).toBe(1);

    now = 12_775;
    emitAssistantText({
      handler,
      runId: "run-replay-after-ignore",
      seq: 2,
      text: "Hello",
    });

    expect(chatRunState.buffers.get("client-replay-after-ignore")).toBe("Hello world");
    expect(chatRunState.lastAcceptedSeq.get("client-replay-after-ignore")).toBe(1);

    now = 12_975;
    emitAssistantText({
      handler,
      runId: "run-replay-after-ignore",
      seq: 2,
      text: "Hello world!",
    });

    expect(chatRunState.buffers.get("client-replay-after-ignore")).toBe("Hello world!");
    expect(chatRunState.lastAcceptedSeq.get("client-replay-after-ignore")).toBe(2);

    emitLifecycleEnd(handler, "run-replay-after-ignore", 3);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world", "Hello world!", "Hello world!"]);
    nowSpy.mockRestore();
  });

  it("replaces stale buffer with a shorter recognized full snapshot while recovering", () => {
    let now = 12_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-recover-shorter", {
      sessionKey: "session-recover-shorter",
      clientRunId: "client-recover-shorter",
    });

    emitAssistantText({
      handler,
      runId: "run-recover-shorter",
      seq: 1,
      text: "Hello world",
    });

    now = 13_000;
    emitAssistantText({
      handler,
      runId: "run-recover-shorter",
      seq: 3,
      text: "",
      delta: "!",
    });
    expect(chatRunState.waitingForRecovery.has("client-recover-shorter")).toBe(true);

    now = 13_200;
    emitAssistantText({
      handler,
      runId: "run-recover-shorter",
      seq: 4,
      text: "Hello",
    });

    expect(chatRunState.waitingForRecovery.has("client-recover-shorter")).toBe(false);
    expect(chatRunState.buffers.get("client-recover-shorter")).toBe("Hello");

    emitLifecycleEnd(handler, "run-recover-shorter", 5);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world", "Hello", "Hello"]);
    nowSpy.mockRestore();
  });

  it("recovers from a missed first assistant chunk when the next ACP snapshot is cumulative", () => {
    let now = 12_850;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-first-gap", {
      sessionKey: "session-first-gap",
      clientRunId: "client-first-gap",
    });

    emitLifecycleStart(handler, "run-first-gap", 1);

    now = 13_050;
    emitAssistantText({
      handler,
      runId: "run-first-gap",
      seq: 3,
      text: "Hello world",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-first-gap")).toBe(false);
    expect(chatRunState.buffers.get("client-first-gap")).toBe("Hello world");

    emitLifecycleEnd(handler, "run-first-gap", 4);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world", "Hello world"]);
    nowSpy.mockRestore();
  });

  it("gap recovery does not accept empty-base text equals delta as full replacement", () => {
    let now = 12_860;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-gap-empty-base-mirrored", {
      sessionKey: "session-gap-empty-base-mirrored",
      clientRunId: "client-gap-empty-base-mirrored",
    });

    emitLifecycleStart(handler, "run-gap-empty-base-mirrored", 1);

    now = 13_060;
    emitAssistantText({
      handler,
      runId: "run-gap-empty-base-mirrored",
      seq: 3,
      text: " world",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-gap-empty-base-mirrored")).toBe(true);
    expect(chatRunState.buffers.get("client-gap-empty-base-mirrored")).toBeUndefined();
    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);

    now = 13_260;
    emitAssistantText({
      handler,
      runId: "run-gap-empty-base-mirrored",
      seq: 4,
      text: "Hello world",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-gap-empty-base-mirrored")).toBe(false);
    expect(chatRunState.buffers.get("client-gap-empty-base-mirrored")).toBe("Hello world");
    expect(chatRunState.lastAcceptedSeq.get("client-gap-empty-base-mirrored")).toBe(4);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world"]);
    nowSpy.mockRestore();
  });

  it("does not treat the first assistant text after lifecycle start as a gap", () => {
    let now = 12_600;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-start-gap", {
      sessionKey: "session-start-gap",
      clientRunId: "client-start-gap",
    });

    emitLifecycleStart(handler, "run-start-gap", 1);

    now = 12_800;
    emitAssistantText({
      handler,
      runId: "run-start-gap",
      seq: 2,
      text: "Hello from start",
    });

    expect(chatRunState.waitingForRecovery.has("client-start-gap")).toBe(false);
    expect(chatRunState.buffers.get("client-start-gap")).toBe("Hello from start");

    emitLifecycleEnd(handler, "run-start-gap", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const payloadTexts = chatCalls
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello from start", "Hello from start"]);
    nowSpy.mockRestore();
  });

  it("healthy first assistant packet may still accept empty-base text equals delta", () => {
    let now = 12_620;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-healthy-first-mirrored", {
      sessionKey: "session-healthy-first-mirrored",
      clientRunId: "client-healthy-first-mirrored",
    });

    emitLifecycleStart(handler, "run-healthy-first-mirrored", 1);

    now = 12_820;
    emitAssistantText({
      handler,
      runId: "run-healthy-first-mirrored",
      seq: 2,
      text: "Hello",
      delta: "Hello",
    });

    expect(chatRunState.waitingForRecovery.has("client-healthy-first-mirrored")).toBe(false);
    expect(chatRunState.buffers.get("client-healthy-first-mirrored")).toBe("Hello");
    expect(chatRunState.lastAcceptedSeq.get("client-healthy-first-mirrored")).toBe(2);

    emitLifecycleEnd(handler, "run-healthy-first-mirrored", 3);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello"]);
    nowSpy.mockRestore();
  });

  it("does not treat seen tool and lifecycle events between assistant updates as a chat gap", () => {
    let now = 12_900;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-interleaved", {
      sessionKey: "session-interleaved",
      clientRunId: "client-interleaved",
    });

    emitAssistantText({
      handler,
      runId: "run-interleaved",
      seq: 1,
      text: "Hello",
    });

    now = 13_100;
    emitToolStart({
      handler,
      runId: "run-interleaved",
      seq: 2,
      toolCallId: "tool-interleaved",
    });

    now = 13_300;
    emitFallbackLifecycle({
      handler,
      runId: "run-interleaved",
      seq: 3,
    });

    now = 13_500;
    emitAssistantText({
      handler,
      runId: "run-interleaved",
      seq: 4,
      text: "",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-interleaved")).toBe(false);
    expect(chatRunState.buffers.get("client-interleaved")).toBe("Hello world");

    emitLifecycleEnd(handler, "run-interleaved", 5);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const payloadTexts = chatCalls
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello world", "Hello world"]);
    nowSpy.mockRestore();
  });

  it("drops assistant chunks older than highest seen seq and waits for a safe recovery snapshot", () => {
    let now = 13_650;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-delayed-older", {
      sessionKey: "session-delayed-older",
      clientRunId: "client-delayed-older",
    });

    emitAssistantText({
      handler,
      runId: "run-delayed-older",
      seq: 1,
      text: "Hello",
    });

    now = 13_850;
    emitToolStart({
      handler,
      runId: "run-delayed-older",
      seq: 3,
      toolCallId: "tool-delayed-older",
    });

    now = 14_050;
    emitAssistantText({
      handler,
      runId: "run-delayed-older",
      seq: 2,
      text: "Hello world",
    });

    expect(chatRunState.waitingForRecovery.has("client-delayed-older")).toBe(true);
    expect(chatRunState.buffers.get("client-delayed-older")).toBe("Hello");
    expect(chatRunState.lastAcceptedSeq.get("client-delayed-older")).toBe(1);

    now = 14_250;
    emitAssistantText({
      handler,
      runId: "run-delayed-older",
      seq: 4,
      text: "Hello world!",
    });

    expect(chatRunState.waitingForRecovery.has("client-delayed-older")).toBe(false);
    expect(chatRunState.buffers.get("client-delayed-older")).toBe("Hello world!");
    expect(chatRunState.lastAcceptedSeq.get("client-delayed-older")).toBe(4);

    emitLifecycleEnd(handler, "run-delayed-older", 5);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello world!", "Hello world!"]);
    nowSpy.mockRestore();
  });

  it("recovers from a seq gap with a cumulative full text + delta replacement", () => {
    let now = 12_700;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-recover", {
      sessionKey: "session-recover",
      clientRunId: "client-recover",
    });

    emitAssistantText({
      handler,
      runId: "run-recover",
      seq: 1,
      text: "Hello",
    });

    now = 12_900;
    emitAssistantText({
      handler,
      runId: "run-recover",
      seq: 3,
      text: "",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-recover")).toBe(true);

    now = 13_100;
    emitAssistantText({
      handler,
      runId: "run-recover",
      seq: 4,
      text: "Hello world",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-recover")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.get("client-recover")).toBe(4);

    now = 13_300;
    emitAssistantText({
      handler,
      runId: "run-recover",
      seq: 5,
      text: "Hello world!",
    });

    emitLifecycleEnd(handler, "run-recover", 6);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(4);
    const payloadTexts = chatCalls
      .slice(0, 3)
      .map(
        ([, payload]) => (payload as { message?: { content?: Array<{ text?: string }> } }).message,
      )
      .map((message) => message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello world", "Hello world!"]);
    const finalPayload = chatCalls[3]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Hello world!");
    nowSpy.mockRestore();
  });

  it("does not advance lastAcceptedSeq for same-text recovery snapshots, so same-seq replay can still be accepted", () => {
    let now = 13_320;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-recovery-replay", {
      sessionKey: "session-recovery-replay",
      clientRunId: "client-recovery-replay",
    });

    emitAssistantText({
      handler,
      runId: "run-recovery-replay",
      seq: 1,
      text: "Hello",
    });
    expect(chatRunState.lastAcceptedSeq.get("client-recovery-replay")).toBe(1);

    now = 13_520;
    emitAssistantText({
      handler,
      runId: "run-recovery-replay",
      seq: 3,
      text: "",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-recovery-replay")).toBe(true);

    now = 13_720;
    emitAssistantText({
      handler,
      runId: "run-recovery-replay",
      seq: 4,
      text: "Hello",
    });

    expect(chatRunState.waitingForRecovery.has("client-recovery-replay")).toBe(false);
    expect(chatRunState.buffers.get("client-recovery-replay")).toBe("Hello");
    expect(chatRunState.lastAcceptedSeq.get("client-recovery-replay")).toBe(1);

    now = 13_920;
    emitAssistantText({
      handler,
      runId: "run-recovery-replay",
      seq: 4,
      text: "Hello world",
      delta: " world",
    });

    expect(chatRunState.buffers.get("client-recovery-replay")).toBe("Hello world");
    expect(chatRunState.lastAcceptedSeq.get("client-recovery-replay")).toBe(4);

    emitLifecycleEnd(handler, "run-recovery-replay", 5);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello world", "Hello world"]);
    nowSpy.mockRestore();
  });

  it("keeps recovery latched on same-text packets that still carry new delta text", () => {
    let now = 13_940;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-recovery-same-text-delta", {
      sessionKey: "session-recovery-same-text-delta",
      clientRunId: "client-recovery-same-text-delta",
    });

    emitAssistantText({
      handler,
      runId: "run-recovery-same-text-delta",
      seq: 1,
      text: "Hello",
    });
    expect(chatRunState.lastAcceptedSeq.get("client-recovery-same-text-delta")).toBe(1);

    now = 14_140;
    emitAssistantText({
      handler,
      runId: "run-recovery-same-text-delta",
      seq: 3,
      text: "",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-recovery-same-text-delta")).toBe(true);
    expect(chatRunState.buffers.get("client-recovery-same-text-delta")).toBe("Hello");

    now = 14_340;
    emitAssistantText({
      handler,
      runId: "run-recovery-same-text-delta",
      seq: 4,
      text: "Hello",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-recovery-same-text-delta")).toBe(true);
    expect(chatRunState.buffers.get("client-recovery-same-text-delta")).toBe("Hello");
    expect(chatRunState.lastAcceptedSeq.get("client-recovery-same-text-delta")).toBe(1);

    now = 14_540;
    emitAssistantText({
      handler,
      runId: "run-recovery-same-text-delta",
      seq: 5,
      text: "",
      delta: "!",
    });

    expect(chatRunState.waitingForRecovery.has("client-recovery-same-text-delta")).toBe(true);
    expect(chatRunState.buffers.get("client-recovery-same-text-delta")).toBe("Hello");

    now = 14_740;
    emitAssistantText({
      handler,
      runId: "run-recovery-same-text-delta",
      seq: 6,
      text: "Hello world",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-recovery-same-text-delta")).toBe(false);
    expect(chatRunState.buffers.get("client-recovery-same-text-delta")).toBe("Hello world");
    expect(chatRunState.lastAcceptedSeq.get("client-recovery-same-text-delta")).toBe(6);

    emitLifecycleEnd(handler, "run-recovery-same-text-delta", 7);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello world", "Hello world"]);
    nowSpy.mockRestore();
  });

  it("accepts the first safe full snapshot immediately after a seq gap", () => {
    let now = 13_350;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-gap-snapshot", {
      sessionKey: "session-gap-snapshot",
      clientRunId: "client-gap-snapshot",
    });

    emitAssistantText({
      handler,
      runId: "run-gap-snapshot",
      seq: 1,
      text: "Hello",
    });

    now = 13_550;
    emitAssistantText({
      handler,
      runId: "run-gap-snapshot",
      seq: 3,
      text: "Hello world",
      delta: " world",
    });

    expect(chatRunState.waitingForRecovery.has("client-gap-snapshot")).toBe(false);
    expect(chatRunState.buffers.get("client-gap-snapshot")).toBe("Hello world");

    emitLifecycleEnd(handler, "run-gap-snapshot", 4);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const payloadTexts = chatCalls
      .map(
        ([, payload]) => (payload as { message?: { content?: Array<{ text?: string }> } }).message,
      )
      .map((message) => message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello", "Hello world", "Hello world"]);
    nowSpy.mockRestore();
  });

  it("uses one effective run key when source runId and client runId differ", () => {
    let now = 13_500;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, agentRunSeq, chatRunState, handler } = createHarness();
    chatRunState.registry.add("source-run", {
      sessionKey: "session-effective-key",
      clientRunId: "client-run",
    });

    emitAssistantText({
      handler,
      runId: "source-run",
      seq: 1,
      text: "Hello",
    });

    expect(chatRunState.buffers.get("client-run")).toBe("Hello");
    expect(chatRunState.buffers.has("source-run")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.get("client-run")).toBe(1);
    expect(agentRunSeq.get("client-run")).toBe(1);

    now = 13_700;
    emitAssistantText({
      handler,
      runId: "source-run",
      seq: 1,
      text: "Hello again",
    });

    emitLifecycleEnd(handler, "source-run", 2);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const finalPayload = chatCalls[1]?.[1] as {
      runId?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.runId).toBe("client-run");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Hello");
    nowSpy.mockRestore();
  });

  it("clears effective-run-key state on error so a reused client run starts fresh", () => {
    let now = 13_900;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("source-error", {
      sessionKey: "session-reuse",
      clientRunId: "client-reuse",
    });

    emitAssistantText({
      handler,
      runId: "source-error",
      seq: 1,
      text: "Hello",
    });

    now = 14_100;
    emitAssistantText({
      handler,
      runId: "source-error",
      seq: 3,
      text: "",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-reuse")).toBe(true);

    handler({
      runId: "source-error",
      seq: 4,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "error", error: "boom" },
    });

    expect(chatRunState.buffers.has("client-reuse")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-reuse")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-reuse")).toBe(false);
    expect(chatRunState.deltaSentAt.has("client-reuse")).toBe(false);
    expect(chatRunState.deltaLastBroadcastLen.has("client-reuse")).toBe(false);

    chatRunState.registry.add("source-reuse", {
      sessionKey: "session-reuse",
      clientRunId: "client-reuse",
    });
    chatRunState.pendingRestartEffectiveRunKeys.add("client-reuse");
    chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.set("client-reuse", "source-reuse");
    now = 14_300;
    emitLifecycleStart(handler, "source-reuse", 1);
    emitAssistantText({
      handler,
      runId: "source-reuse",
      seq: 2,
      text: "Fresh start",
    });
    emitLifecycleEnd(handler, "source-reuse", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    const finalPayload = chatCalls.at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Fresh start");
    nowSpy.mockRestore();
  });

  it("clears sessionless effective-run state on terminal lifecycle cleanup", () => {
    const { agentRunSeq, chatRunState, handler } = createHarness({
      resolveSessionKeyForRun: () => undefined,
    });

    handler({
      runId: "run-no-session",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "invisible" },
    });
    expect(chatRunState.lastSeenEventSeq.get("run-no-session")).toBe(1);
    expect(agentRunSeq.get("run-no-session")).toBe(1);

    handler({
      runId: "run-no-session",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(chatRunState.lastSeenEventSeq.has("run-no-session")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("run-no-session")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("run-no-session")).toBe(false);
    expect(agentRunSeq.has("run-no-session")).toBe(false);
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
    expect(agentRunSeq.get("run-cleanup")).toBeUndefined();
    expect(agentRunSeq.get("client-cleanup")).toBe(1);

    handler({
      runId: "run-cleanup",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    expect(agentRunSeq.has("run-cleanup")).toBe(false);
    expect(agentRunSeq.has("client-cleanup")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-cleanup")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-cleanup")).toBe(false);
    nowSpy?.mockRestore();
  });

  it("drops stale events that arrive after lifecycle completion", () => {
    const { broadcast, nodeSendToSession, chatRunState, handler, nowSpy } = createHarness({
      now: 2_500,
    });
    chatRunState.registry.add("run-stale-tail", {
      sessionKey: "session-stale-tail",
      clientRunId: "client-stale-tail",
    });

    handler({
      runId: "run-stale-tail",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "done" },
    });
    emitLifecycleEnd(handler, "run-stale-tail");
    const errorCallsBeforeStaleEvent = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    ).length;
    const sessionChatCallsBeforeStaleEvent = sessionChatCalls(nodeSendToSession).length;

    handler({
      runId: "run-stale-tail",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "late tail" },
    });

    const errorCalls = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" && (payload as { stream?: string }).stream === "error",
    );
    expect(errorCalls).toHaveLength(errorCallsBeforeStaleEvent);
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(sessionChatCallsBeforeStaleEvent);
    nowSpy?.mockRestore();
  });

  it("ignores non-finite seq values for agent-run monotonic tracking", () => {
    const { agentRunSeq, broadcast, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-non-finite",
    });

    emitFallbackLifecycle({
      handler,
      runId: "run-non-finite",
      seq: Number.NaN,
    });

    expect(agentRunSeq.has("run-non-finite")).toBe(false);
    const gapErrorsAfterInvalid = broadcast.mock.calls.filter(
      ([event, payload]) =>
        event === "agent" &&
        (payload as { stream?: string; data?: { reason?: string } }).stream === "error" &&
        (payload as { data?: { reason?: string } }).data?.reason === "seq gap",
    );
    expect(gapErrorsAfterInvalid).toHaveLength(0);

    emitFallbackLifecycle({
      handler,
      runId: "run-non-finite",
      seq: 1,
    });

    expect(agentRunSeq.get("run-non-finite")).toBe(1);
  });

  it("trims overlap when appending allowed delta-only chunks", () => {
    let now = 13_800;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-overlap", {
      sessionKey: "session-overlap",
      clientRunId: "client-overlap",
    });

    emitAssistantText({
      handler,
      runId: "run-overlap",
      seq: 1,
      text: "Hello wor",
    });

    now = 14_000;
    emitAssistantText({
      handler,
      runId: "run-overlap",
      seq: 2,
      text: "",
      delta: "world",
    });

    emitLifecycleEnd(handler, "run-overlap", 3);

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(3);
    const finalPayload = chatCalls[2]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Hello world");
    nowSpy.mockRestore();
  });

  it("clears recovery seq state on abort teardown before the next run reuses the key", () => {
    let now = 14_200;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { agentRunSeq, broadcast, nodeSendToSession, chatRunState, handler } = createHarness();
    chatRunState.registry.add("client-abort-reuse", {
      sessionKey: "session-abort-reuse",
      clientRunId: "client-abort-reuse",
    });

    emitAssistantText({
      handler,
      runId: "client-abort-reuse",
      seq: 1,
      text: "Hello",
    });

    now = 14_400;
    emitAssistantText({
      handler,
      runId: "client-abort-reuse",
      seq: 3,
      text: "",
      delta: " world",
    });
    expect(chatRunState.waitingForRecovery.has("client-abort-reuse")).toBe(true);

    const entry = {
      controller: new AbortController(),
      sessionId: "session-abort-reuse",
      sessionKey: "session-abort-reuse",
      startedAtMs: now,
      expiresAtMs: now + 30_000,
    };
    const chatAbortControllers = new Map([["client-abort-reuse", entry]]);
    agentRunSeq.set("client-abort-reuse", 3);

    const res = abortChatRunById(
      {
        chatAbortControllers,
        chatAbortedRuns: chatRunState.abortedRuns,
        chatRunState,
        removeChatRun: chatRunState.registry.remove,
        agentRunSeq,
        broadcast,
        nodeSendToSession,
      },
      {
        runId: "client-abort-reuse",
        sessionKey: "session-abort-reuse",
      },
    );

    expect(res).toEqual({ aborted: true });
    expect(chatRunState.lastSeenEventSeq.has("client-abort-reuse")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-abort-reuse")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-abort-reuse")).toBe(false);

    // Simulate the old aborted run's terminal cleanup having already completed.
    clearEffectiveChatRunState(chatRunState, "client-abort-reuse");
    chatRunState.abortedRuns.delete("client-abort-reuse");
    chatRunState.registry.add("client-abort-reuse", {
      sessionKey: "session-abort-reuse",
      clientRunId: "client-abort-reuse",
    });

    now = 14_600;
    emitAssistantText({
      handler,
      runId: "client-abort-reuse",
      seq: 1,
      text: "Fresh start",
    });
    emitLifecycleEnd(handler, "client-abort-reuse", 2);

    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Fresh start");
    nowSpy.mockRestore();
  });

  it("flushes buffered chat delta before tool start events", () => {
    let now = 12_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const {
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      chatRunState,
      toolEventRecipients,
      handler,
    } = createHarness({
      resolveSessionKeyForRun: () => "session-tool-flush",
    });

    chatRunState.registry.add("run-tool-flush", {
      sessionKey: "session-tool-flush",
      clientRunId: "client-tool-flush",
    });
    registerAgentRunContext("run-tool-flush", {
      sessionKey: "session-tool-flush",
      verboseLevel: "off",
    });
    toolEventRecipients.add("run-tool-flush", "conn-1");

    handler({
      runId: "run-tool-flush",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool" },
    });

    // Throttled assistant update (within 150ms window).
    now = 12_050;
    handler({
      runId: "run-tool-flush",
      seq: 2,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Before tool expanded" },
    });

    handler({
      runId: "run-tool-flush",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "read", toolCallId: "tool-flush-1" },
    });

    const chatCalls = chatBroadcastCalls(broadcast);
    expect(chatCalls).toHaveLength(2);
    const flushedPayload = chatCalls[1]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(flushedPayload.state).toBe("delta");
    expect(flushedPayload.message?.content?.[0]?.text).toBe("Before tool expanded");
    expect(sessionChatCalls(nodeSendToSession)).toHaveLength(2);

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    const flushCallOrder = broadcast.mock.invocationCallOrder[1] ?? 0;
    const toolCallOrder = broadcastToConnIds.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
    expect(flushCallOrder).toBeLessThan(toolCallOrder);
    nowSpy.mockRestore();
    resetAgentRunContextForTest();
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

  it("mirrors tool events to session subscribers so late-joining operator UIs can render them", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-1",
    });

    registerAgentRunContext("run-session-tool", { sessionKey: "session-1", verboseLevel: "off" });
    sessionEventSubscribers.subscribe("conn-session");

    handler({
      runId: "run-session-tool",
      seq: 1,
      stream: "tool",
      ts: 1_234,
      data: {
        phase: "start",
        name: "exec",
        toolCallId: "tool-session-1",
        args: { command: "echo hi" },
      },
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.tool",
      expect.objectContaining({
        runId: "run-session-tool",
        sessionKey: "session-1",
        stream: "tool",
        ts: 1_234,
        data: expect.objectContaining({
          phase: "start",
          name: "exec",
          toolCallId: "tool-session-1",
          args: { command: "echo hi" },
        }),
      }),
      new Set(["conn-session"]),
      { dropIfSlow: true },
    );
    resetAgentRunContextForTest();
  });

  it("broadcasts terminal session status to session subscribers on lifecycle end", () => {
    const { broadcastToConnIds, sessionEventSubscribers, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-finished",
    });

    sessionEventSubscribers.subscribe("conn-session");
    registerAgentRunContext("run-finished", {
      sessionKey: "session-finished",
      verboseLevel: "off",
    });

    handler({
      runId: "run-finished",
      seq: 1,
      stream: "lifecycle",
      ts: 1_000,
      data: {
        phase: "start",
        startedAt: 900,
      },
    });
    handler({
      runId: "run-finished",
      seq: 2,
      stream: "lifecycle",
      ts: 1_800,
      data: {
        phase: "end",
        startedAt: 900,
        endedAt: 1_700,
      },
    });

    const sessionsChangedCalls = broadcastToConnIds.mock.calls.filter(
      ([event]) => event === "sessions.changed",
    );
    expect(sessionsChangedCalls).toHaveLength(2);
    expect(sessionsChangedCalls[1]?.[1]).toEqual(
      expect.objectContaining({
        sessionKey: "session-finished",
        phase: "end",
        status: "done",
        startedAt: 900,
        endedAt: 1_700,
        runtimeMs: 800,
        updatedAt: 1_700,
        abortedLastRun: false,
      }),
    );
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledWith({
      sessionKey: "session-finished",
      event: expect.objectContaining({
        runId: "run-finished",
        data: expect.objectContaining({ phase: "end" }),
      }),
    });
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

  it("suppresses chat and node session events for non-control-UI-visible runs", () => {
    const { broadcast, nodeSendToSession, handler } = createHarness({
      resolveSessionKeyForRun: () => "session-hidden",
    });
    registerAgentRunContext("run-hidden", {
      sessionKey: "session-hidden",
      isControlUiVisible: false,
      verboseLevel: "off",
    });

    handler({
      runId: "run-hidden",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Reply from imessage" },
    });
    emitLifecycleEnd(handler, "run-hidden", 2);

    expect(chatBroadcastCalls(broadcast)).toHaveLength(0);
    expect(nodeSendToSession).not.toHaveBeenCalled();
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

  it("does not resurrect seq state when a stale assistant event arrives after terminal cleanup", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 2_700 });
    chatRunState.registry.add("run-post-final-stale", {
      sessionKey: "session-post-final-stale",
      clientRunId: "client-post-final-stale",
    });

    emitAssistantText({
      handler,
      runId: "run-post-final-stale",
      seq: 1,
      text: "Hello",
    });
    emitLifecycleEnd(handler, "run-post-final-stale", 2);

    expect(chatRunState.finalizedEffectiveRunKeys.has("client-post-final-stale")).toBe(true);
    expect(chatRunState.lastSeenEventSeq.has("client-post-final-stale")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-post-final-stale")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-post-final-stale")).toBe(false);
    expect(chatRunState.buffers.has("client-post-final-stale")).toBe(false);

    const chatCallsBeforeStale = chatBroadcastCalls(broadcast).length;
    handler({
      runId: "run-post-final-stale",
      seq: 3,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "late tail" },
    });

    expect(chatRunState.finalizedEffectiveRunKeys.has("client-post-final-stale")).toBe(true);
    expect(chatRunState.lastSeenEventSeq.has("client-post-final-stale")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-post-final-stale")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-post-final-stale")).toBe(false);
    expect(chatRunState.buffers.has("client-post-final-stale")).toBe(false);
    expect(chatBroadcastCalls(broadcast)).toHaveLength(chatCallsBeforeStale);
    nowSpy?.mockRestore();
  });

  it("finalized run ignores seq=1 replay unless lifecycle start", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 2_800 });
    chatRunState.registry.add("run-finalized-seq1-replay", {
      sessionKey: "session-finalized-seq1-replay",
      clientRunId: "client-finalized-seq1-replay",
    });

    emitAssistantText({
      handler,
      runId: "run-finalized-seq1-replay",
      seq: 1,
      text: "Original",
    });
    emitLifecycleEnd(handler, "run-finalized-seq1-replay", 2);

    expect(chatRunState.finalizedEffectiveRunKeys.has("client-finalized-seq1-replay")).toBe(true);
    expect(chatRunState.buffers.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatRunState.lastSeenEventSeq.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-finalized-seq1-replay")).toBe(false);

    const chatCallsBeforeReplay = chatBroadcastCalls(broadcast).length;
    handler({
      runId: "run-finalized-seq1-replay",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "late replay", delta: "late replay" },
    });

    expect(chatRunState.finalizedEffectiveRunKeys.has("client-finalized-seq1-replay")).toBe(true);
    expect(chatRunState.buffers.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatRunState.lastSeenEventSeq.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatRunState.waitingForRecovery.has("client-finalized-seq1-replay")).toBe(false);
    expect(chatBroadcastCalls(broadcast)).toHaveLength(chatCallsBeforeReplay);
    nowSpy?.mockRestore();
  });

  it("allows a finalized client-visible key to start fresh after a stale post-final tail", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 2_900 });
    chatRunState.registry.add("run-reuse-before-final", {
      sessionKey: "session-reuse-after-final",
      clientRunId: "client-reuse-after-final",
    });

    emitAssistantText({
      handler,
      runId: "run-reuse-before-final",
      seq: 1,
      text: "Original",
    });
    emitLifecycleEnd(handler, "run-reuse-before-final", 2);

    handler({
      runId: "run-reuse-before-final",
      seq: 3,
      stream: "tool",
      ts: Date.now(),
      data: { phase: "start", name: "late", toolCallId: "late-tool" },
    });

    expect(chatRunState.finalizedEffectiveRunKeys.has("client-reuse-after-final")).toBe(true);
    expect(chatRunState.lastSeenEventSeq.has("client-reuse-after-final")).toBe(false);

    chatRunState.registry.add("run-reuse-after-final", {
      sessionKey: "session-reuse-after-final",
      clientRunId: "client-reuse-after-final",
    });
    chatRunState.pendingRestartEffectiveRunKeys.add("client-reuse-after-final");
    chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.set(
      "client-reuse-after-final",
      "run-reuse-after-final",
    );

    emitLifecycleStart(handler, "run-reuse-after-final", 1);
    emitAssistantText({
      handler,
      runId: "run-reuse-after-final",
      seq: 2,
      text: "Fresh start",
    });

    expect(chatRunState.finalizedEffectiveRunKeys.has("client-reuse-after-final")).toBe(false);
    expect(chatRunState.lastSeenEventSeq.get("client-reuse-after-final")).toBe(2);
    expect(chatRunState.lastAcceptedSeq.get("client-reuse-after-final")).toBe(2);
    expect(chatRunState.waitingForRecovery.has("client-reuse-after-final")).toBe(false);
    expect(chatRunState.buffers.get("client-reuse-after-final")).toBe("Fresh start");

    emitLifecycleEnd(handler, "run-reuse-after-final", 3);
    const finalPayload = chatBroadcastCalls(broadcast).at(-1)?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(finalPayload.state).toBe("final");
    expect(finalPayload.message?.content?.[0]?.text).toBe("Fresh start");
    nowSpy?.mockRestore();
  });

  it("reused key fresh run may start from first observed assistant seq 2 after pending restart", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 3_000 });
    chatRunState.registry.add("run-reuse-pending-old", {
      sessionKey: "session-reuse-pending-start",
      clientRunId: "client-reuse-pending-start",
    });

    emitAssistantText({
      handler,
      runId: "run-reuse-pending-old",
      seq: 1,
      text: "Original",
    });
    emitLifecycleEnd(handler, "run-reuse-pending-old", 2);

    chatRunState.pendingRestartEffectiveRunKeys.add("client-reuse-pending-start");
    chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.set(
      "client-reuse-pending-start",
      "run-reuse-pending-new",
    );
    chatRunState.registry.add("run-reuse-pending-new", {
      sessionKey: "session-reuse-pending-start",
      clientRunId: "client-reuse-pending-start",
    });

    emitAssistantText({
      handler,
      runId: "run-reuse-pending-new",
      seq: 2,
      text: "Fresh start",
      delta: "Fresh start",
    });

    expect(chatRunState.pendingRestartEffectiveRunKeys.has("client-reuse-pending-start")).toBe(
      false,
    );
    expect(chatRunState.finalizedEffectiveRunKeys.has("client-reuse-pending-start")).toBe(false);
    expect(chatRunState.lastSeenEventSeq.get("client-reuse-pending-start")).toBe(2);
    expect(chatRunState.lastAcceptedSeq.get("client-reuse-pending-start")).toBe(2);
    expect(chatRunState.waitingForRecovery.has("client-reuse-pending-start")).toBe(false);
    expect(chatRunState.buffers.get("client-reuse-pending-start")).toBe("Fresh start");

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text)
      .filter(Boolean);
    expect(payloadTexts.at(-1)).toBe("Fresh start");
    nowSpy?.mockRestore();
  });

  it("reused agent chat run ignores fresh stale replay until new run actually starts", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 3_100 });
    chatRunState.registry.add("agent-run-old", {
      sessionKey: "agent:main:main",
      clientRunId: "agent-client-reuse",
    });

    emitAssistantText({
      handler,
      runId: "agent-run-old",
      seq: 1,
      text: "Original",
    });
    emitLifecycleEnd(handler, "agent-run-old", 2);

    chatRunState.pendingRestartEffectiveRunKeys.add("agent-client-reuse");
    chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.set(
      "agent-client-reuse",
      "agent-run-new",
    );
    chatRunState.registry.add("agent-run-new", {
      sessionKey: "agent:main:main",
      clientRunId: "agent-client-reuse",
    });

    const chatCallsBeforeReplay = chatBroadcastCalls(broadcast).length;
    handler({
      runId: "agent-run-old",
      seq: 10,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "stale old tail", delta: "stale old tail" },
    });

    expect(chatRunState.finalizedEffectiveRunKeys.has("agent-client-reuse")).toBe(true);
    expect(chatRunState.pendingRestartEffectiveRunKeys.has("agent-client-reuse")).toBe(true);
    expect(chatRunState.lastSeenEventSeq.has("agent-client-reuse")).toBe(false);
    expect(chatRunState.lastAcceptedSeq.has("agent-client-reuse")).toBe(false);
    expect(chatRunState.buffers.has("agent-client-reuse")).toBe(false);
    expect(chatBroadcastCalls(broadcast)).toHaveLength(chatCallsBeforeReplay);

    emitLifecycleStart(handler, "agent-run-new", 1);
    emitAssistantText({
      handler,
      runId: "agent-run-new",
      seq: 2,
      text: "Fresh start",
    });

    expect(chatRunState.finalizedEffectiveRunKeys.has("agent-client-reuse")).toBe(false);
    expect(chatRunState.pendingRestartEffectiveRunKeys.has("agent-client-reuse")).toBe(false);
    expect(chatRunState.lastSeenEventSeq.get("agent-client-reuse")).toBe(2);
    expect(chatRunState.lastAcceptedSeq.get("agent-client-reuse")).toBe(2);
    expect(chatRunState.buffers.get("agent-client-reuse")).toBe("Fresh start");
    nowSpy?.mockRestore();
  });

  it("reused agent chat run may start from first observed assistant seq 2 after pending restart", () => {
    const { broadcast, chatRunState, handler, nowSpy } = createHarness({ now: 3_200 });
    chatRunState.registry.add("agent-run-old-seq2", {
      sessionKey: "agent:main:main",
      clientRunId: "agent-client-reuse-seq2",
    });

    emitAssistantText({
      handler,
      runId: "agent-run-old-seq2",
      seq: 1,
      text: "Original",
    });
    emitLifecycleEnd(handler, "agent-run-old-seq2", 2);

    chatRunState.pendingRestartEffectiveRunKeys.add("agent-client-reuse-seq2");
    chatRunState.pendingRestartSourceRunIdsByEffectiveRunKey.set(
      "agent-client-reuse-seq2",
      "agent-run-new-seq2",
    );
    chatRunState.registry.add("agent-run-new-seq2", {
      sessionKey: "agent:main:main",
      clientRunId: "agent-client-reuse-seq2",
    });

    emitAssistantText({
      handler,
      runId: "agent-run-new-seq2",
      seq: 2,
      text: "Fresh start",
      delta: "Fresh start",
    });

    expect(chatRunState.pendingRestartEffectiveRunKeys.has("agent-client-reuse-seq2")).toBe(false);
    expect(chatRunState.finalizedEffectiveRunKeys.has("agent-client-reuse-seq2")).toBe(false);
    expect(chatRunState.lastSeenEventSeq.get("agent-client-reuse-seq2")).toBe(2);
    expect(chatRunState.lastAcceptedSeq.get("agent-client-reuse-seq2")).toBe(2);
    expect(chatRunState.waitingForRecovery.has("agent-client-reuse-seq2")).toBe(false);
    expect(chatRunState.buffers.get("agent-client-reuse-seq2")).toBe("Fresh start");

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text)
      .filter(Boolean);
    expect(payloadTexts.at(-1)).toBe("Fresh start");
    nowSpy?.mockRestore();
  });

  it("does not enter recovery for a same-text full snapshot, so later in-order deltas still append", () => {
    let now = 12_580;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const { broadcast, chatRunState, handler } = createHarness();
    chatRunState.registry.add("run-benign-noop", {
      sessionKey: "session-benign-noop",
      clientRunId: "client-benign-noop",
    });

    emitAssistantText({
      handler,
      runId: "run-benign-noop",
      seq: 1,
      text: "Hello world",
    });

    now = 12_780;
    emitAssistantText({
      handler,
      runId: "run-benign-noop",
      seq: 2,
      text: "Hello world",
    });

    expect(chatRunState.waitingForRecovery.has("client-benign-noop")).toBe(false);
    expect(chatRunState.buffers.get("client-benign-noop")).toBe("Hello world");

    now = 12_980;
    emitAssistantText({
      handler,
      runId: "run-benign-noop",
      seq: 3,
      text: "",
      delta: "!",
    });

    expect(chatRunState.buffers.get("client-benign-noop")).toBe("Hello world!");
    expect(chatRunState.waitingForRecovery.has("client-benign-noop")).toBe(false);

    emitLifecycleEnd(handler, "run-benign-noop", 4);

    const payloadTexts = chatBroadcastCalls(broadcast)
      .map(([, payload]) => payload as { message?: { content?: Array<{ text?: string }> } })
      .map((payload) => payload.message?.content?.[0]?.text);
    expect(payloadTexts).toEqual(["Hello world", "Hello world!", "Hello world!"]);
    nowSpy.mockRestore();
  });
});
