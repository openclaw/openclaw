import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { createCliEventHandlers } from "../agents/cli-runner/execute-events.js";
import { createCliToolTracking } from "../agents/cli-runner/execute-tool-tracking.js";
import {
  type AgentEventRuntimePayload,
  onAgentRuntimeEvent,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { abortChatRunById, registerChatAbortController } from "./chat-abort.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { emitAgentEvent, registerChatRun } from "./server-chat.agent-events.test-helpers.js";
import {
  createAgentEventHandler,
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { broadcastChatFinal } from "./server-methods/chat-broadcast.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

function createHarness(
  audience: Omit<Parameters<typeof createGatewayBroadcaster>[0], "clients"> = {},
) {
  vi.useFakeTimers();
  const clients = new GatewayClientRegistry();
  const broadcaster = createGatewayBroadcaster({ clients, ...audience });
  const chatRunState = createChatRunState();
  const options = {
    broadcast: vi.fn(broadcaster.broadcast),
    broadcastToConnIds: vi.fn(broadcaster.broadcastToConnIds),
    nodeSendToSession: vi.fn(),
    nodeHasSessionSubscribers: () => true,
    agentRunSeq: new Map<string, number>(),
    chatRunState,
    resolveSessionKeyForRun: () => undefined,
    clearAgentRunContext: vi.fn(),
    toolEventRecipients: chatRunState.toolEventRecipients,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    persistGatewaySessionLifecycleEventForEvent: vi.fn(async () => undefined),
  };
  const handler = createAgentEventHandler(options);
  return {
    ...options,
    handler,
    clients,
    broadcaster,
    registerRun(runId: string, sessionKey: string) {
      registerChatRun(chatRunState, runId, sessionKey, runId);
      return (
        seq: number,
        stream: AgentEventRuntimePayload["stream"],
        data: Record<string, unknown>,
      ) => emitAgentEvent(handler, runId, stream, data, { seq });
    },
    [Symbol.dispose]() {
      handler.dispose();
      chatRunState.clear();
      options.agentRunSeq.clear();
    },
  };
}
function emitLifecycleEnd(
  handler: ReturnType<typeof createHarness>["handler"],
  runId: string,
  seq: number,
) {
  emitAgentEvent(handler, runId, "lifecycle", { phase: "end" }, { seq });
}
function answerCandidate(itemId: string, progressText: string, status = "candidate") {
  return {
    itemId,
    kind: "answer_candidate",
    title: "Answer candidate",
    phase: "update",
    status,
    progressText,
    source: "test",
    hideFromChannelProgress: true,
  };
}
function connect(
  clients: GatewayClientRegistry,
  connId: string,
  completeWrite: (callback?: () => void) => void = (callback) => callback?.(),
  caps: string[] = [],
) {
  const frames: Array<{
    event: string;
    seq: number;
    payload: {
      stream?: string;
      message?: unknown;
      data?: { text?: string; delta?: string };
      state?: string;
      deltaText?: string;
    };
  }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: (
      wire: string | Buffer,
      options?: { binary: false } | (() => void),
      callback?: () => void,
    ) => {
      frames.push(JSON.parse(wire.toString()));
      completeWrite(typeof options === "function" ? options : callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  });
  const client = {
    connId,
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      role: "operator",
      scopes: ["operator.read"],
      caps,
    },
  } satisfies GatewayWsClient;
  clients.add(client);
  return { frames, client, socket };
}
type Frames = ReturnType<typeof connect>["frames"];
const payloads = (frames: Frames, event: string) =>
  frames.filter((frame) => frame.event === event).map((frame) => frame.payload);
const chatDeltaText = (frames: Frames) =>
  payloads(frames, "chat")
    .filter((payload) => payload.state === "delta")
    .map((payload) => payload.deltaText)
    .join("");

afterEach(() => vi.useRealTimers());

it("keeps non-text agent events for chat-only clients", () => {
  const onBroadcast = vi.fn();
  using harness = createHarness({ onBroadcast, canReceiveSessionEvent: () => true });
  const { clients } = harness;
  const { frames: legacy } = connect(clients, "legacy");
  const { frames: chatOnly } = connect(clients, "chat-only", undefined, [
    GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
  ]);
  const runId = "progress-run";
  const emit = harness.registerRun(runId, "agent:main:progress");
  harness.toolEventRecipients.add(runId, "legacy");
  harness.toolEventRecipients.add(runId, "chat-only");
  const events: Array<Pick<AgentEventRuntimePayload, "stream" | "data">> = [
    { stream: "assistant", data: { text: "Hello", delta: "Hello" } },
    { stream: "tool", data: { phase: "start", name: "read", toolCallId: "tool-1" } },
    { stream: "item", data: answerCandidate("candidate", "Progress") },
    { stream: "usage", data: { outputTokens: 1 } },
    { stream: "run_status", data: { phase: "retrying", message: "Retrying" } },
    { stream: "plan", data: { phase: "update", steps: [] } },
    { stream: "approval", data: { phase: "requested", approvalId: "approval-1" } },
    { stream: "thinking", data: { text: "Thinking" } },
    { stream: "assistant", data: { mediaUrl: "https://example.com/image.png" } },
    { stream: "lifecycle", data: { phase: "finishing" } },
  ];
  events.forEach(({ stream, data }, index) => emit(index + 1, stream, data));
  harness.chatRunState.flushPendingText(runId);
  const progress = payloads(chatOnly, "agent");
  expect(progress.map((payload) => payload.stream)).toEqual(
    events.slice(1).map(({ stream }) => stream),
  );
  expect(progress).toEqual(payloads(legacy, "agent").slice(1));
  expect(onBroadcast).toHaveBeenCalledWith(
    "agent",
    expect.objectContaining({ stream: "assistant", data: { text: "Hello", delta: "Hello" } }),
    expect.any(Object),
  );
  expect(chatOnly.map(({ seq }) => seq)).toEqual(chatOnly.map((_, index) => index + 1));
});

it("sends append-only wire text while retaining snapshots for observers and late recipients", () => {
  let visible = true;
  using harness = createHarness({ canReceiveSessionEvent: () => visible });
  const { clients, handler, chatRunState } = harness;
  const { frames } = connect(clients, "first");
  const { frames: chatOnly } = connect(clients, "chat-only", undefined, [
    GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
  ]);
  registerChatRun(chatRunState, "wire-run", "agent:main:wire", "wire-run");
  const emit = (
    seq: number,
    text: string | undefined,
    delta: string | undefined,
    replace?: true,
    itemId = "answer",
  ) => {
    emitAgentEvent(handler, "wire-run", "assistant", { itemId, text, delta, replace }, { seq });
    chatRunState.flushPendingText("wire-run");
  };
  emit(1, undefined, "Hello");
  const { frames: late } = connect(clients, "late");
  emit(2, undefined, " world");
  expect(payloads(frames, "chat")).toEqual([
    expect.objectContaining({ message: expect.any(Object), deltaText: "Hello" }),
    expect.not.objectContaining({ message: expect.anything() }),
  ]);
  expect(payloads(frames, "agent").at(-1)?.data).toEqual({
    itemId: "answer",
    delta: " world",
  });
  expect(payloads(late, "chat")[0]?.message).toMatchObject({
    content: [{ type: "text", text: "Hello world" }],
  });
  expect(payloads(late, "agent")[0]?.data?.text).toBe("Hello world");
  expect(harness.broadcast.mock.calls.findLast(([event]) => event === "agent")?.[1]).toMatchObject({
    data: { text: "Hello world" },
  });
  emit(3, "Rewritten", "", true);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    replace: true,
    message: { content: [{ type: "text", text: "Rewritten" }] },
  });
  visible = false;
  emit(4, "Reset", undefined);
  visible = true;
  emit(5, "Reset!", "!");
  expect(payloads(frames, "agent").at(-1)?.data?.text).toBe("Reset!");
  emit(6, "Other", "Other", undefined, "other");
  emit(7, "Reset! again", " again");
  expect(payloads(frames, "agent").at(-1)?.data?.text).toBe("Reset! again");
  emitLifecycleEnd(handler, "wire-run", 8);
  expect(frames.at(-1)?.payload).toMatchObject({
    state: "final",
    message: { content: [{ type: "text", text: "Reset!\n\nOther\n\nReset! again" }] },
  });
  expect(chatOnly.map(({ event, payload }) => ({ event, payload }))).toEqual(
    frames
      .filter(({ event, payload }) => event !== "agent" || payload.stream !== "assistant")
      .map(({ event, payload }) => ({ event, payload })),
  );
  expect(chatOnly.map(({ seq }) => seq)).toEqual(chatOnly.map((_, index) => index + 1));
});

it.each(["immediate", "paced", "slow"])(
  "preserves real CLI output transforms through %s wire delivery",
  (mode) => {
    const replacement = "foobaz";
    const harness = createHarness();
    const { clients, broadcaster, handler, chatRunState } = harness;
    const callbacks: Array<() => void> = [];
    let hold = false;
    const { frames } = connect(clients, "cli-reader", (callback) => {
      if (callback && hold) {
        callbacks.push(callback);
      } else {
        callback?.();
      }
    });
    const runId = `cli-transform-${mode}`;
    harness.registerRun(runId, `agent:main:${runId}`);
    const context = buildPreparedCliRunContext({ runId });
    context.backendResolved.textTransforms = { output: [{ from: /foobar/g, to: replacement }] };
    const cli = createCliEventHandlers({
      context,
      toolTracking: createCliToolTracking(context),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const dispose = onAgentRuntimeEvent((event) => {
      if (event.runId === runId) {
        handler(event);
      }
    });
    try {
      cli.emitCliAssistantDelta({ text: "foo", delta: "foo" });
      chatRunState.flushPendingText(runId);
      if (mode === "slow") {
        hold = true;
        broadcaster.broadcast("tick", {});
      }
      cli.emitCliAssistantDelta({ text: "foobar", delta: "bar" });
      if (mode !== "paced") {
        chatRunState.flushPendingText(runId);
      }
      cli.emitCliAssistantDelta({ text: "foobarbaz", delta: "baz" });
      chatRunState.flushPendingText(runId);
      hold = false;
      while (callbacks.length) {
        callbacks.shift()?.();
      }
      expect(payloads(frames, "agent").map((payload) => payload.data)).toEqual([
        { text: "foo", delta: "foo" },
        ...(mode === "immediate"
          ? [{ text: replacement, delta: "bar" }, { delta: "baz" }]
          : [{ text: `${replacement}baz`, delta: "barbaz" }]),
      ]);
    } finally {
      dispose();
      harness[Symbol.dispose]();
      resetAgentEventsForTest({ preserveListeners: true });
    }
  },
);

it.each([true, false])("re-baselines after an upstream sequence gap (visible=%s)", (visible) => {
  using harness = createHarness();
  const { clients, handler, chatRunState } = harness;
  const { frames } = connect(clients, "gap-reader");
  const { frames: chatOnly } = connect(clients, "chat-only", undefined, [
    GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT,
  ]);
  const runId = "gap-run";
  const sessionKey = "agent:main:gap-proof";
  harness.sessionMessageSubscribers.subscribe("gap-reader", sessionKey);
  harness.sessionMessageSubscribers.subscribe("chat-only", sessionKey);
  const emit = (seq: number, text: string, delta: string) => {
    const event: AgentEventRuntimePayload = {
      runId,
      sessionKey,
      seq,
      ts: seq,
      stream: "assistant",
      controlUiVisible: visible,
      projectSessionLifecycle: false,
      data: { itemId: "reply", phase: "commentary", text, delta },
    };
    handler(event);
  };
  emit(1, "A", "A");
  emit(2, "AB", "B");
  // Keep B paced when the source skips C. The next known snapshot must repair both.
  emit(4, "ABCD", "D");
  chatRunState.flushPendingText(runId);
  expect(payloads(frames, "agent").at(-1)?.data).toMatchObject({ text: "ABCD", delta: "D" });
  emit(5, "ABCDE", "E");
  chatRunState.flushPendingText(runId);
  expect(payloads(frames, "agent").at(-1)?.data).toEqual({
    itemId: "reply",
    phase: "commentary",
    delta: "E",
  });
  expect(chatOnly.some(({ payload }) => payload.stream === "assistant")).toBe(false);
  expect(payloads(chatOnly, "chat")).toEqual(payloads(frames, "chat"));
  expect(chatOnly.map(({ seq }) => seq)).toEqual(chatOnly.map((_, index) => index + 1));
});

it.each(["native", "dispatch", "abort", "retry", "clearRun", "clear"] as const)(
  "bounds connection snapshots until %s completion without losing the terminal reply",
  (terminal) => {
    using harness = createHarness();
    const { chatRunState, nodeSendToSession, clients, broadcaster } = harness;
    const callbacks: Array<() => void> = [];
    const { frames, client, socket } = connect(clients, "held-reader", (callback) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const runId = "backpressured-run";
    const sessionKey = "agent:main:backpressured";
    const emit = harness.registerRun(runId, sessionKey);
    const chunks = Array.from({ length: 24 }, (_, i) => `[${i}]${"abc🚀".repeat(64)}`);
    let expected = chunks.join("");

    let text = "";
    for (const [index, delta] of chunks.entries()) {
      text += delta;
      emit(index * 2 + 1, "item", answerCandidate("answer", text));
      emit(index * 2 + 2, "assistant", { text, delta });
      vi.advanceTimersByTime(75);
    }
    // The existing producer pacing still delivers updates to nodes, but a
    // socket with an unfinished write must not retain every historical prefix.
    expect(nodeSendToSession.mock.calls.length).toBeGreaterThan(chunks.length);
    expect(frames.length).toBeLessThan(6);
    if (terminal === "retry" || terminal === "clearRun" || terminal === "clear") {
      expect(broadcaster.getBufferedAmount(client.connId)).toBeGreaterThan(socket.bufferedAmount);
      if (terminal === "retry") {
        emit(49, "assistant", { text: `${expected} failed tail` });
        emit(50, "lifecycle", { phase: "error", error: "retryable failure" });
        expect(chatDeltaText(frames)).toBe(`${expected} failed tail`);
      } else if (terminal === "clearRun") {
        chatRunState.clearRun(runId);
      } else {
        chatRunState.clear();
        harness.registerRun(runId, sessionKey);
      }
      expect(broadcaster.getBufferedAmount(client.connId)).toBe(socket.bufferedAmount);
      expected = "successor reply";
      emit(51, "assistant", { text: expected, delta: expected });
      emit(52, "lifecycle", { phase: "end" });
    } else if (terminal === "native") {
      emit(chunks.length * 2 + 1, "item", answerCandidate("answer", expected, "selected"));
      emit(chunks.length * 2 + 2, "lifecycle", { phase: "end" });
    } else if (terminal === "dispatch") {
      broadcastChatFinal({
        context: { ...harness, ...broadcaster },
        runId,
        sessionKey,
        message: { role: "assistant", content: [{ type: "text", text: expected }] },
      });
      chatRunState.clearRun(runId);
    } else {
      const chatAbortControllers = new Map();
      registerChatAbortController({
        chatAbortControllers,
        runId,
        sessionId: runId,
        sessionKey,
        timeoutMs: 60_000,
      });
      expect(
        abortChatRunById(
          {
            ...harness,
            ...broadcaster,
            chatAbortControllers,
            removeChatRun: (sourceRunId, clientRunId, key) =>
              chatRunState.registry.remove(sourceRunId, clientRunId, key),
          },
          { runId, sessionKey },
        ).aborted,
      ).toBe(true);
    }
    const beforeDrain = frames.length;
    while (callbacks.length) {
      callbacks.shift()?.();
    }
    expect(frames).toHaveLength(beforeDrain);
    expect(frames.map(({ seq }) => seq)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.at(-1)).toMatchObject({
      event: "chat",
      payload: {
        state: terminal === "abort" ? "aborted" : "final",
        message: { content: [{ type: "text", text: expected }] },
      },
    });
    if (terminal === "native" || terminal === "dispatch") {
      expect(
        payloads(frames, "agent")
          .filter((payload) => payload.stream === "assistant")
          .map((payload) => payload.data?.delta)
          .join(""),
      ).toBe(expected);
      expect(chatDeltaText(frames)).toBe(expected);
    }
    expect(socket.close).not.toHaveBeenCalled();
  },
);
