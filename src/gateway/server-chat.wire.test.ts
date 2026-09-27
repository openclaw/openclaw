import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
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

function createHarness() {
  const chatRunState = createChatRunState();
  const options = {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
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
  return { ...options, handler: createAgentEventHandler(options) };
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
) {
  const frames: Array<{
    event: string;
    payload: { message?: unknown; data?: { text?: string; delta?: string }; state?: string };
  }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: (wire: string, callback?: () => void) => {
      frames.push(JSON.parse(wire));
      completeWrite(callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  });
  clients.add({
    connId,
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      role: "operator",
      scopes: ["operator.read"],
    },
  } satisfies GatewayWsClient);
  return frames;
}

afterEach(() => vi.useRealTimers());

it("sends append-only wire text while retaining snapshots for observers and late recipients", () => {
  vi.useFakeTimers();
  const harness = createHarness();
  const clients = new GatewayClientRegistry();
  const frames = connect(clients, "first");
  let visible = true;
  const broadcaster = createGatewayBroadcaster({
    clients,
    canReceiveSessionEvent: () => visible,
  });
  harness.broadcast.mockImplementation(broadcaster.broadcast);
  harness.broadcastToConnIds.mockImplementation(broadcaster.broadcastToConnIds);
  const { handler, chatRunState } = harness;
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
  try {
    emit(1, undefined, "Hello");
    const late = connect(clients, "late");
    emit(2, undefined, " world");
    expect(frames.filter((frame) => frame.event === "chat").map((frame) => frame.payload)).toEqual([
      expect.objectContaining({ message: expect.any(Object), deltaText: "Hello" }),
      expect.not.objectContaining({ message: expect.anything() }),
    ]);
    expect(frames.findLast((frame) => frame.event === "agent")?.payload.data).toEqual({
      itemId: "answer",
      delta: " world",
    });
    expect(late.find((frame) => frame.event === "chat")?.payload.message).toMatchObject({
      content: [{ type: "text", text: "Hello world" }],
    });
    expect(late.find((frame) => frame.event === "agent")?.payload.data?.text).toBe("Hello world");
    expect(
      harness.broadcast.mock.calls.findLast(([event]) => event === "agent")?.[1].data.text,
    ).toBe("Hello world");
    emit(3, "Rewritten", "", true);
    expect(frames.findLast((frame) => frame.event === "chat")?.payload).toMatchObject({
      replace: true,
      message: { content: [{ type: "text", text: "Rewritten" }] },
    });
    visible = false;
    emit(4, "Reset", undefined);
    visible = true;
    emit(5, "Reset!", "!");
    expect(frames.findLast((frame) => frame.event === "agent")?.payload.data?.text).toBe("Reset!");
    emit(6, "Other", "Other", undefined, "other");
    emit(7, "Reset! again", " again");
    expect(frames.findLast((frame) => frame.event === "agent")?.payload.data?.text).toBe(
      "Reset! again",
    );
    emitLifecycleEnd(handler, "wire-run", 8);
    expect(frames.at(-1)?.payload).toMatchObject({
      state: "final",
      message: { content: [{ type: "text", text: "Reset!\n\nOther\n\nReset! again" }] },
    });
  } finally {
    handler.dispose();
    chatRunState.clear();
  }
});

it.each(
  ["immediate", "paced", "slow"].flatMap((mode) =>
    ["X", "foobaz"].map((replacement) => ({ mode, replacement })),
  ),
)(
  "preserves real CLI output transforms through $mode wire delivery ($replacement)",
  ({ mode, replacement }) => {
    vi.useFakeTimers();
    const harness = createHarness();
    const clients = new GatewayClientRegistry();
    const callbacks: Array<() => void> = [];
    let hold = false;
    const frames = connect(clients, "cli-reader", (callback) => {
      if (callback && hold) {
        callbacks.push(callback);
      } else {
        callback?.();
      }
    });
    const broadcaster = createGatewayBroadcaster({ clients });
    harness.broadcast.mockImplementation(broadcaster.broadcast);
    const { handler, chatRunState } = harness;
    const runId = `cli-transform-${mode}`;
    registerChatRun(chatRunState, runId, `agent:main:${runId}`, runId);
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
      const assistant = frames.filter((frame) => frame.event === "agent");
      expect(assistant.map((frame) => frame.payload.data)).toEqual([
        { text: "foo", delta: "foo" },
        ...(mode === "immediate"
          ? [{ text: replacement, delta: "bar" }, { delta: "baz" }]
          : [{ text: `${replacement}baz`, delta: "barbaz" }]),
      ]);
    } finally {
      dispose();
      handler.dispose();
      chatRunState.clear();
      resetAgentEventsForTest({ preserveListeners: true });
    }
  },
);

it.each([true, false])("re-baselines after an upstream sequence gap (visible=%s)", (visible) => {
  vi.useFakeTimers();
  const harness = createHarness();
  const clients = new GatewayClientRegistry();
  const frames = connect(clients, "gap-reader");
  const broadcaster = createGatewayBroadcaster({ clients });
  harness.broadcast.mockImplementation(broadcaster.broadcast);
  harness.broadcastToConnIds.mockImplementation(broadcaster.broadcastToConnIds);
  const { handler, chatRunState } = harness;
  const runId = "gap-run";
  const sessionKey = "agent:main:gap-proof";
  harness.sessionMessageSubscribers.subscribe("gap-reader", sessionKey);
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
  try {
    emit(1, "A", "A");
    emit(2, "AB", "B");
    // Keep B paced when the source skips C. The next known snapshot must repair both.
    emit(4, "ABCD", "D");
    chatRunState.flushPendingText(runId);
    const assistant = frames.filter((frame) => frame.event === "agent");
    expect(assistant.at(-1)?.payload.data).toMatchObject({ text: "ABCD", delta: "D" });
    emit(5, "ABCDE", "E");
    chatRunState.flushPendingText(runId);
    expect(frames.findLast((frame) => frame.event === "agent")?.payload.data).toEqual({
      itemId: "reply",
      phase: "commentary",
      delta: "E",
    });
  } finally {
    handler.dispose();
    chatRunState.clear();
  }
});

it.each(["native", "dispatch", "abort", "retry", "clearRun", "clear"] as const)(
  "bounds connection snapshots until %s completion without losing the terminal reply",
  (terminal) => {
    vi.useFakeTimers();
    const harness = createHarness();
    const { handler, chatRunState, nodeSendToSession, agentRunSeq } = harness;
    const callbacks: Array<() => void> = [];
    const frames: Array<{
      event: string;
      seq: number;
      payload: {
        stream?: string;
        data?: { delta?: string };
        state?: string;
        deltaText?: string;
      };
    }> = [];
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      bufferedAmount: 0,
      send: (wire: string, callback?: () => void) => {
        frames.push(JSON.parse(wire));
        if (callback) {
          callbacks.push(callback);
        }
      },
      close: vi.fn(),
      terminate: vi.fn(),
    });
    const client = {
      connId: "held-reader",
      socket,
      usesSharedGatewayAuth: false,
      connect: {
        minProtocol: 4,
        maxProtocol: 4,
        client: { id: "test", version: "test", platform: "test", mode: "test" },
        role: "operator",
        scopes: ["operator.read"],
      },
    } satisfies GatewayWsClient;
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([client]),
    });
    harness.broadcast.mockImplementation(broadcaster.broadcast);
    harness.broadcastToConnIds.mockImplementation(broadcaster.broadcastToConnIds);
    const runId = "backpressured-run";
    const sessionKey = "agent:main:backpressured";
    registerChatRun(chatRunState, runId, sessionKey, runId);
    const chunks = Array.from({ length: 24 }, (_, i) => `[${i}]${"abc🚀".repeat(64)}`);
    let expected = chunks.join("");

    try {
      let text = "";
      for (const [index, delta] of chunks.entries()) {
        text += delta;
        emitAgentEvent(handler, runId, "item", answerCandidate("answer", text), {
          seq: index * 2 + 1,
        });
        emitAgentEvent(handler, runId, "assistant", { text, delta }, { seq: index * 2 + 2 });
        vi.advanceTimersByTime(75);
      }
      // The existing producer pacing still delivers updates to nodes, but a
      // socket with an unfinished write must not retain every historical prefix.
      expect(nodeSendToSession.mock.calls.length).toBeGreaterThan(chunks.length);
      expect(frames.length).toBeLessThan(6);
      if (terminal === "retry" || terminal === "clearRun" || terminal === "clear") {
        expect(broadcaster.getBufferedAmount(client.connId)).toBeGreaterThan(socket.bufferedAmount);
        if (terminal === "retry") {
          emitAgentEvent(
            handler,
            runId,
            "assistant",
            { text: `${expected} failed tail` },
            { seq: 49 },
          );
          emitAgentEvent(
            handler,
            runId,
            "lifecycle",
            { phase: "error", error: "retryable failure" },
            { seq: 50 },
          );
          expect(
            frames
              .filter((frame) => frame.event === "chat" && frame.payload.state === "delta")
              .map((frame) => frame.payload.deltaText)
              .join(""),
          ).toBe(`${expected} failed tail`);
        } else if (terminal === "clearRun") {
          chatRunState.clearRun(runId);
        } else {
          chatRunState.clear();
          registerChatRun(chatRunState, runId, sessionKey, runId);
        }
        expect(broadcaster.getBufferedAmount(client.connId)).toBe(socket.bufferedAmount);
        expected = "successor reply";
        emitAgentEvent(
          handler,
          runId,
          "assistant",
          { text: expected, delta: expected },
          { seq: 51 },
        );
        emitLifecycleEnd(handler, runId, 52);
      } else if (terminal === "native") {
        emitAgentEvent(handler, runId, "item", answerCandidate("answer", expected, "selected"), {
          seq: chunks.length * 2 + 1,
        });
        emitLifecycleEnd(handler, runId, chunks.length * 2 + 2);
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
          frames
            .filter((f) => f.event === "agent" && f.payload.stream === "assistant")
            .map((f) => f.payload.data?.delta)
            .join(""),
        ).toBe(expected);
        expect(
          frames
            .filter((f) => f.event === "chat" && f.payload.state === "delta")
            .map((f) => f.payload.deltaText)
            .join(""),
        ).toBe(expected);
      }
      expect(socket.close).not.toHaveBeenCalled();
    } finally {
      handler.dispose();
      chatRunState.clear();
      agentRunSeq.clear();
    }
  },
);
