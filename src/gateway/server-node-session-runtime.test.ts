import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import type { AgentEventRuntimePayload } from "../infra/agent-events.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED } from "./events.js";
import { updateNodeRunnerInventory } from "./node-registry-private.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import {
  createChatRunState,
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createAgentEventHandler } from "./server-chat.js";
import { broadcastChatTerminal } from "./server-methods/chat-broadcast.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const assistantMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

function createRuntime(
  overrides: Partial<Parameters<typeof createGatewayNodeSessionRuntime>[0]> = {},
  generation: string | null = "generation-a",
) {
  const pairing = { identity: "identity-a", generation: generation ?? undefined, present: true };
  const runtime = createGatewayNodeSessionRuntime({
    broadcast: vi.fn(),
    resolveCurrentPairingState: async () => (pairing.present ? { ...pairing } : undefined),
    isPairingStateCurrent: (_nodeId, expected) =>
      pairing.present &&
      expected.identity === pairing.identity &&
      expected.generation === pairing.generation,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    ...overrides,
  });
  return Object.assign(runtime, { pairing });
}

function registerNode(
  runtime: ReturnType<typeof createRuntime>,
  connId: string,
  pairingGeneration: string | undefined,
) {
  const frames: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn((payload: string) => frames.push(payload)),
    close: vi.fn(),
  };
  const client: GatewayWsClient = {
    socket: socket as unknown as GatewayWsClient["socket"],
    connId,
    usesSharedGatewayAuth: false,
    connect: {
      role: "node",
      scopes: [],
      client: { id: "node-host", version: "1.0.0", platform: "macos", mode: "node" },
      device: { id: "node-a" },
    } as unknown as GatewayWsClient["connect"],
  };
  runtime.nodeRegistry.register(client, {
    pairingIdentity: "identity-a",
    pairingGeneration,
  });
  return { socket, client, frames };
}

function pairedSubscriber(event: "chat" | "agent", sessionKey = "main", subscribe = true) {
  const entered = createDeferred();
  const pairing = { ...createDeferred<string>(), delayed: false };
  const runtime = createRuntime({
    resolveCurrentPairingState: async () => {
      if (pairing.delayed) {
        entered.resolve();
      }
      return {
        identity: "identity-a",
        generation: pairing.delayed ? await pairing.promise : "generation-a",
      };
    },
  });
  const { socket, frames } = registerNode(runtime, "conn-original", "generation-a");
  if (subscribe) {
    runtime.nodeSubscribe("node-a", sessionKey, "conn-original");
  }
  const group = new AbortController();
  const publisher = {
    group,
    send: (
      text: string,
      delta: string,
      boundary: { version?: unknown; snapshot?: boolean; isCurrent?: () => boolean } = {},
    ) => {
      const deltaPayload =
        event === "chat"
          ? { runId: "run-a", state: "delta", deltaText: delta }
          : { runId: "run-a", stream: "assistant", data: { delta } };
      const payload =
        event === "chat"
          ? { ...deltaPayload, message: assistantMessage(text) }
          : { ...deltaPayload, data: { text, delta } };
      const opts: GatewayBroadcastOpts = {
        liveText: {
          group: group.signal,
          isCurrent: boundary.isCurrent,
          projection: {
            key: event,
            delta: () => deltaPayload,
            text: event === "agent" ? { snapshot: text, delta } : undefined,
            version: boundary.version,
            snapshot: boundary.snapshot,
          },
        },
      };
      return runtime.nodeSendToSession(sessionKey, event, payload, opts);
    },
  };
  const chatRunState = createChatRunState();
  const sends: Promise<void>[] = [];
  const context = {
    ...runtime,
    broadcast: vi.fn(),
    agentRunSeq: new Map(),
    chatRunState,
    nodeSendToSession: (...args: Parameters<typeof runtime.nodeSendToSession>) => {
      sends.push(runtime.nodeSendToSession(...args));
    },
  };
  return {
    runtime,
    frames,
    socket,
    publisher,
    context,
    chatRunState,
    sends,
    pairing,
    entered: entered.promise,
    release: () => pairing.resolve("generation-a"),
  };
}

function publishInventory(runtime: ReturnType<typeof createRuntime>, available: number) {
  return updateNodeRunnerInventory({
    registry: runtime.nodeRegistry,
    nodeId: "node-a",
    connId: "conn-original",
    declaration: {
      protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
      workerHost: { enabled: true, capacity: { total: 1, available } },
    },
  });
}

const inventoryBroadcast = [
  GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
  { nodeId: "node-a" },
  { dropIfSlow: true },
];
const inventoryOrder = [
  "availability",
  "inventory",
  `broadcast:${GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED}`,
];

test.each(["chat", "agent"] as const)(
  "%s snapshots attach, resubscribe, and changed projections while preserving append ordering",
  async (event) => {
    const { runtime, frames, publisher } = pairedSubscriber(event, "main", false);
    await publisher.send("A", "A");
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    const first = publisher.send("AB", "B");
    const append = publisher.send("ABC", "C");
    const tool = runtime.nodeSendToSession("main", "agent", { stream: "tool" });
    await Promise.all([first, append, tool]);
    runtime.nodeUnsubscribe("node-a", "main", "conn-original");
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    await publisher.send("ABCD", "D");
    await publisher.send("X", "X", { version: "canvas-1" });
    await publisher.send("XY", "Y", { version: "canvas-1" });
    await publisher.send("Z", "Z", { version: "canvas-1", snapshot: true });
    publisher.group.abort();
    await publisher.send("stale", "stale");
    await runtime.nodeSendToSession(
      "main",
      "chat",
      { state: "final", message: assistantMessage("Z") },
      { liveText: { group: publisher.group.signal } },
    );

    const payloads = frames.map((frame) => JSON.parse(frame).payload);
    const snapshot = (index: number) =>
      event === "chat" ? payloads[index].message?.content[0].text : payloads[index].data?.text;
    expect(payloads).toHaveLength(8);
    const snapshots = [0, 1, 3, 4, 5, 6].map(snapshot);
    expect(snapshots).toEqual(["AB", undefined, "ABCD", "X", undefined, "Z"]);
    expect(event === "chat" ? payloads[1].deltaText : payloads[1].data.delta).toBe("C");
    expect(payloads[2]).toEqual({ stream: "tool" });
    expect(payloads[7]).toMatchObject({
      state: "final",
      message: { content: [{ text: "Z" }] },
    });
  },
);

test("re-baselines after a failed send or a skipped publication", async () => {
  const { socket, publisher, frames } = pairedSubscriber("chat");
  await publisher.send("A", "A");
  vi.mocked(socket.send).mockImplementationOnce(() => {
    throw new Error("send failed");
  });
  await publisher.send("AB", "B");
  await publisher.send("ABC", "C");
  await publisher.send("ABCD", "D", { isCurrent: () => false });
  await publisher.send("ABCDE", "E");

  const texts = frames.map((frame) => JSON.parse(frame).payload.message.content[0].text);
  expect(texts).toEqual(["A", "ABC", "ABCDE"]);
});

test("preserves transformed assistant snapshots before resuming queued appends", async () => {
  const f = pairedSubscriber("agent");
  const { publisher, frames } = f;
  await publisher.send("foo", "foo");
  f.pairing.delayed = true;
  const transformed = publisher.send("X", "bar");
  const append = publisher.send("Xbaz", "baz");
  await f.entered;
  f.release();
  await Promise.all([transformed, append]);

  expect(frames.map((frame) => JSON.parse(frame).payload.data)).toEqual([
    { text: "foo", delta: "foo" },
    { text: "X", delta: "bar" },
    { delta: "baz" },
  ]);
});

test("does not inherit receipts when a connection is replaced during pairing verification", async () => {
  const f = pairedSubscriber("chat");
  const { publisher, runtime, frames: originalFrames } = f;
  await publisher.send("A", "A");
  f.pairing.delayed = true;
  const pending = publisher.send("AB", "B");
  await f.entered;
  const { frames: replacementFrames } = registerNode(runtime, "conn-replacement", "generation-a");
  f.release();
  await pending;
  f.pairing.delayed = false;
  await publisher.send("ABC", "C");
  await publisher.send("ABCD", "D");

  expect(originalFrames).toHaveLength(1);
  expect(replacementFrames.map((frame) => JSON.parse(frame).payload)).toEqual([
    {
      runId: "run-a",
      state: "delta",
      deltaText: "C",
      message: assistantMessage("ABC"),
    },
    { runId: "run-a", state: "delta", deltaText: "D" },
  ]);
});

test.each([
  { boundary: "final", state: "final", drain: true },
  { boundary: "error", state: "error", drain: true },
  { boundary: "revoked source", state: "final", drain: false },
  { boundary: "cancel", state: "aborted", drain: false },
  { boundary: "unsubscribe", state: "final", drain: false },
  { boundary: "resubscribe", state: "final", drain: false },
] as const)("settles queued node text at $boundary", async ({ boundary, state, drain }) => {
  let current = true;
  const sessionKey = "agent:main:main";
  const f = pairedSubscriber("agent", sessionKey);
  const { publisher, runtime, frames, chatRunState, context, sends } = f;
  chatRunState.getOrCreate("run-a").liveTextGroup = publisher.group;
  await publisher.send("one", "one", { isCurrent: () => current });
  f.pairing.delayed = true;
  const firstTail = publisher.send("one two", " two", { isCurrent: () => current });
  const secondTail = publisher.send("one two three", " three", { isCurrent: () => current });
  await f.entered;
  if (boundary === "revoked source") {
    current = false;
  }
  if (boundary === "cancel") {
    chatRunState.clearRun("run-a");
  }
  broadcastChatTerminal({
    terminalEntry: undefined,
    context,
    runId: "run-a",
    sessionKey,
    state,
  });
  // Normal terminal cleanup releases the producer while authenticated writes wait.
  current = false;
  chatRunState.clearRun("run-a");
  if (boundary === "unsubscribe" || boundary === "resubscribe") {
    runtime.nodeUnsubscribe("node-a", sessionKey, "conn-original");
    if (boundary === "resubscribe") {
      runtime.nodeSubscribe("node-a", sessionKey, "conn-original");
    }
  }
  f.release();
  await Promise.all([firstTail, secondTail, ...sends]);

  const events = frames.map((frame) => JSON.parse(frame));
  expect(
    events.filter((frame) => frame.event === "agent").map((frame) => frame.payload.data),
  ).toEqual([
    { text: "one", delta: "one" },
    ...(drain ? [{ delta: " two" }, { delta: " three" }] : []),
  ]);
  expect(events.some((frame) => frame.payload.state === state)).toBe(
    boundary !== "unsubscribe" && boundary !== "resubscribe",
  );
});

test.each([
  { stream: "tool", gap: { phase: "start", toolCallId: "gap-tool", name: "read" } },
  { stream: "lifecycle", gap: { phase: "end" } },
] as const)(
  "drains the queued assistant tail when the source gap arrives on $stream",
  async ({ stream, gap }) => {
    vi.useFakeTimers();
    const sessionKey = "agent:main:node-source-gap";
    const f = pairedSubscriber("agent", sessionKey);
    const { frames, context, chatRunState, sends } = f;
    const handler = createAgentEventHandler({
      ...context,
      broadcastToConnIds: vi.fn(),
      resolveSessionKeyForRun: () => sessionKey,
      clearAgentRunContext: vi.fn(),
      toolEventRecipients: chatRunState.toolEventRecipients,
      persistGatewaySessionLifecycleEventForEvent: vi.fn(async () => undefined),
    });
    const emit = (
      seq: number,
      eventStream: AgentEventRuntimePayload["stream"],
      data: Record<string, unknown>,
    ) => {
      const event: AgentEventRuntimePayload = {
        runId: "run-source-gap",
        sessionKey,
        seq,
        ts: seq,
        stream: eventStream,
        data,
        projectSessionLifecycle: false,
        verboseLevel: "full",
      };
      return handler(event);
    };
    try {
      await emit(1, "assistant", { text: "A", delta: "A" });
      await Promise.all(sends);
      f.pairing.delayed = true;
      await emit(2, "assistant", { text: "AB", delta: "B" });
      await emit(4, stream, gap);
      await f.entered;
      f.release();
      await Promise.all(sends);

      const events = frames.map((frame) => JSON.parse(frame));
      const assistant = events.filter(
        (frame) => frame.event === "agent" && frame.payload.stream === "assistant",
      );
      const data = assistant.map((frame) => frame.payload.data);
      expect(data.map((item) => item.delta)).toEqual(["A", "B"]);
      expect(data.reduce((text, item) => item.text ?? text + item.delta, "")).toBe("AB");
      expect(
        events.findIndex((frame) => frame.event === "agent" && frame.payload.stream === stream),
      ).toBeGreaterThan(events.indexOf(assistant[1]));
    } finally {
      f.release();
      await handler.dispose();
      chatRunState.clear();
      vi.useRealTimers();
    }
  },
);

test.each(["replacement", "capacity-only"])("routes runner inventory changes on %s", (change) => {
  const order: string[] = [];
  const broadcast = vi.fn((event: string) => order.push(`broadcast:${event}`));
  const onRunnerStateChanged = vi.fn((_nodeId, state) => {
    if (state.availabilityChanged) {
      order.push("availability");
    }
    if (state.inventoryChanged) {
      order.push("inventory");
    }
  });
  const runtime = createRuntime({ broadcast, onRunnerStateChanged });
  registerNode(runtime, "conn-original", "generation-a");
  const expectChange = (availabilityChanged: boolean, currentRunner: boolean, from: number) => {
    expect(broadcast.mock.calls).toEqual([inventoryBroadcast]);
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(currentRunner);
    expect(onRunnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-a", {
      inventoryChanged: true,
      availabilityChanged,
    });
    expect(order.slice(from)).toEqual(
      availabilityChanged ? inventoryOrder : inventoryOrder.slice(1),
    );
  };

  expect(publishInventory(runtime, change === "replacement" ? 0 : 1)).toEqual({ changed: true });
  expectChange(true, true, 0);

  broadcast.mockClear();
  onRunnerStateChanged.mockClear();
  if (change === "replacement") {
    registerNode(runtime, "conn-replacement", "generation-a");
  } else {
    expect(publishInventory(runtime, 0)).toEqual({ changed: true });
  }
  expectChange(change === "replacement", change !== "replacement", 3);
});

test("forwards subscribed payload json without parsing it again", async () => {
  const runtime = createRuntime();
  const { frames } = registerNode(runtime, "conn-node-a", "generation-a");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
  runtime.nodeSubscribe("node-a", "main", "conn-node-a");
  expect(runtime.nodeHasSessionSubscribers(" main ")).toBe(true);

  const parseSpy = vi.spyOn(JSON, "parse");
  try {
    await runtime.nodeSendToSession("main", "chat", { ok: true });
    expect(frames).toHaveLength(1);
    expect(parseSpy).not.toHaveBeenCalled();
  } finally {
    parseSpy.mockRestore();
  }
  expect(JSON.parse(frames[0] ?? "{}")).toEqual({
    type: "event",
    event: "chat",
    payload: { ok: true },
  });

  runtime.nodeUnsubscribe("node-a", "main", "conn-retired");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
  runtime.nodeUnsubscribe("node-a", "main", "conn-node-a");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
});

test.each([true, false])(
  "fences voice-wake updates with pairing generation: %s",
  async (hasGeneration) => {
    const broadcast = vi.fn();
    const runtime = createRuntime({ broadcast }, hasGeneration ? "generation-a" : null);
    const { client, frames } = registerNode(runtime, "conn-node-a", runtime.pairing.generation);
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");
    const routing = {
      version: 1 as const,
      defaultTarget: { mode: "current" as const },
      routes: [],
      updatedAtMs: 1,
    };

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    if (hasGeneration) {
      runtime.broadcastVoiceWakeRoutingChanged(routing);
    }
    await vi.waitFor(() => expect(frames).toHaveLength(hasGeneration ? 2 : 1));

    if (hasGeneration) {
      runtime.pairing.generation = "generation-b";
    } else {
      runtime.pairing.present = false;
    }
    runtime.broadcastVoiceWakeChanged(["retired"]);
    if (hasGeneration) {
      runtime.broadcastVoiceWakeRoutingChanged({ ...routing, updatedAtMs: 2 });
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    } else {
      await vi.waitFor(() => expect(client.invalidated).toBe(true));
      expect(send).not.toHaveBeenCalled();
    }

    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
      ...(hasGeneration
        ? [{ type: "event", event: "voicewake.routing.changed", payload: { config: routing } }]
        : []),
    ]);
    expect(broadcast).toHaveBeenCalledTimes(hasGeneration ? 4 : 2);
  },
);

test("does not inherit subscriptions across a replacement pairing generation", async () => {
  const runtime = createRuntime();
  const { frames: originalFrames } = registerNode(runtime, "conn-original", "generation-a");
  runtime.nodeSubscribe("node-a", "main", "conn-original");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
  await runtime.nodeSendToSession("main", "chat", { seq: 1 });
  expect(originalFrames).toHaveLength(1);

  runtime.pairing.generation = "generation-b";
  await runtime.nodeSendToSession("main", "chat", { seq: 2 });
  expect(runtime.nodeRegistry.get("node-a")).toBeUndefined();
  expect(originalFrames).toHaveLength(1);

  const { frames: replacementFrames } = registerNode(runtime, "conn-replacement", "generation-b");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
  runtime.nodeSubscribe("node-a", "retired", "conn-original");
  expect(runtime.nodeHasSessionSubscribers("retired")).toBe(false);
  await runtime.nodeSendToSession("retired", "chat", { seq: 3 });
  expect(replacementFrames).toHaveLength(0);

  runtime.nodeSubscribe("node-a", "main", "conn-replacement");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
  await runtime.nodeSendToSession("main", "chat", { seq: 4 });
  expect(replacementFrames).toHaveLength(1);

  const { frames: reconnectFrames } = registerNode(runtime, "conn-reconnect", "generation-b");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
  await runtime.nodeSendToSession("main", "chat", { seq: 5 });
  expect(reconnectFrames).toHaveLength(1);

  runtime.nodeUnsubscribeAll("node-a");
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
});

test("preserves subscriptions for an exact live pairing generation promotion", async () => {
  const runtime = createRuntime();
  const { frames } = registerNode(runtime, "conn-node-a", "generation-a");
  runtime.nodeSubscribe("node-a", "main", "conn-node-a");
  runtime.pairing.generation = "generation-b";
  const transition = {
    expectedConnId: "conn-node-a",
    expectedPairingIdentity: "identity-a",
    expectedPairingGeneration: "generation-a",
    nextPairingGeneration: "generation-b",
  };
  expect(runtime.nodeRegistry.updateSurface("node-a", { commands: [] }, transition)).not.toBeNull();
  expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
  await runtime.nodeSendToSession("main", "chat", { ok: true });
  expect(frames).toHaveLength(1);
});
