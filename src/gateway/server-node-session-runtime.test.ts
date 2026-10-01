import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
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

type TestSocket = {
  readyState: number;
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
};

function makeGatewayWsClient(connId: string, socket: TestSocket): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connId,
    usesSharedGatewayAuth: false,
    connect: {
      role: "node",
      scopes: [],
      client: {
        id: GATEWAY_CLIENT_IDS.NODE_HOST,
        version: "1.0.0",
        platform: "macos",
        mode: "node",
      },
      device: { id: "node-a" },
    } as unknown as GatewayWsClient["connect"],
  };
}

function createRuntime(
  resolveCurrentPairingGeneration: () => Promise<string>,
  broadcast = vi.fn(),
  isPairingStateCurrent: NonNullable<
    Parameters<typeof createGatewayNodeSessionRuntime>[0]["isPairingStateCurrent"]
  > = (_nodeId, expected) =>
    expected.identity === "identity-a" && expected.generation === "generation-a",
  onRunnerStateChanged?: Parameters<
    typeof createGatewayNodeSessionRuntime
  >[0]["onRunnerStateChanged"],
) {
  return createGatewayNodeSessionRuntime({
    broadcast,
    resolveCurrentPairingState: async () => ({
      identity: "identity-a",
      generation: await resolveCurrentPairingGeneration(),
    }),
    isPairingStateCurrent,
    onRunnerStateChanged,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
}

function registerNode(
  runtime: ReturnType<typeof createRuntime>,
  connId: string,
  pairingGeneration: string,
  frames: string[],
) {
  const socket: TestSocket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn((payload: string) => frames.push(payload)),
    close: vi.fn(),
  };
  runtime.nodeRegistry.register(makeGatewayWsClient(connId, socket), {
    pairingIdentity: "identity-a",
    pairingGeneration,
  });
  return socket;
}

function liveTextPublisher(
  runtime: ReturnType<typeof createRuntime>,
  event: "chat" | "agent",
  sessionKey = "main",
) {
  const group = new AbortController();
  return {
    group,
    send: (
      text: string,
      delta: string,
      boundary: { version?: unknown; snapshot?: boolean; isCurrent?: () => boolean } = {},
    ) => {
      const payload =
        event === "chat"
          ? {
              runId: "run-a",
              state: "delta",
              deltaText: delta,
              message: { role: "assistant", content: [{ type: "text", text }] },
            }
          : { runId: "run-a", stream: "assistant", data: { text, delta } };
      const deltaPayload =
        event === "chat"
          ? { runId: "run-a", state: "delta", deltaText: delta }
          : { runId: "run-a", stream: "assistant", data: { delta } };
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
}

describe("gateway node session runtime", () => {
  test.each(["chat", "agent"] as const)(
    "%s snapshots attach, resubscribe, and changed projections while preserving append ordering",
    async (event) => {
      const frames: string[] = [];
      const runtime = createRuntime(async () => "generation-a");
      registerNode(runtime, "conn-original", "generation-a", frames);
      const publisher = liveTextPublisher(runtime, event);
      await publisher.send("before", "before");
      runtime.nodeSubscribe("node-a", "main", "conn-original");
      const first = publisher.send("before attach", " attach");
      const append = publisher.send("before attach append", " append");
      const tool = runtime.nodeSendToSession("main", "agent", { stream: "tool" });
      await Promise.all([first, append, tool]);
      runtime.nodeUnsubscribe("node-a", "main", "conn-original");
      runtime.nodeSubscribe("node-a", "main", "conn-original");
      await publisher.send("before attach append again", " again");
      await publisher.send("canvas changed", " changed", { version: "canvas-1" });
      await publisher.send("canvas changed more", " more", { version: "canvas-1" });
      await publisher.send("rewrite", "rewrite", { version: "canvas-1", snapshot: true });
      publisher.group.abort();
      await publisher.send("stale", "stale");
      await runtime.nodeSendToSession(
        "main",
        "chat",
        {
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "rewrite" }] },
        },
        { liveText: { group: publisher.group.signal } },
      );

      const payloads = frames.map((frame) => JSON.parse(frame).payload);
      const snapshot = (index: number) =>
        event === "chat" ? payloads[index].message?.content[0].text : payloads[index].data?.text;
      expect(payloads).toHaveLength(8);
      expect(snapshot(0)).toBe("before attach");
      expect(snapshot(1)).toBeUndefined();
      expect(event === "chat" ? payloads[1].deltaText : payloads[1].data.delta).toBe(" append");
      expect(payloads[2]).toEqual({ stream: "tool" });
      expect(snapshot(3)).toBe("before attach append again");
      expect(snapshot(4)).toBe("canvas changed");
      expect(snapshot(5)).toBeUndefined();
      expect(snapshot(6)).toBe("rewrite");
      expect(payloads[7]).toMatchObject({
        state: "final",
        message: { content: [{ text: "rewrite" }] },
      });
    },
  );

  test("re-baselines after a failed send or a skipped publication", async () => {
    const frames: string[] = [];
    const runtime = createRuntime(async () => "generation-a");
    const socket = registerNode(runtime, "conn-original", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    const publisher = liveTextPublisher(runtime, "chat");
    await publisher.send("one", "one");
    vi.mocked(socket.send).mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    await publisher.send("one two", " two");
    await publisher.send("one two three", " three");
    await publisher.send("one two three four", " four", { isCurrent: () => false });
    await publisher.send("one two three four five", " five");

    expect(frames.map((frame) => JSON.parse(frame).payload.message.content[0].text)).toEqual([
      "one",
      "one two three",
      "one two three four five",
    ]);
  });

  test("preserves transformed assistant snapshots before resuming queued appends", async () => {
    const entered = createDeferred();
    const pairing = createDeferred<string>();
    let delayed = false;
    const runtime = createRuntime(() => {
      if (delayed) {
        entered.resolve();
        return pairing.promise;
      }
      return Promise.resolve("generation-a");
    });
    const frames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    const publisher = liveTextPublisher(runtime, "agent");
    await publisher.send("foo", "foo");
    delayed = true;
    const transformed = publisher.send("X", "bar");
    const append = publisher.send("Xbaz", "baz");
    await entered.promise;
    pairing.resolve("generation-a");
    await Promise.all([transformed, append]);

    expect(frames.map((frame) => JSON.parse(frame).payload.data)).toEqual([
      { text: "foo", delta: "foo" },
      { text: "X", delta: "bar" },
      { delta: "baz" },
    ]);
  });

  test("does not inherit receipts when a connection is replaced during pairing verification", async () => {
    const entered = createDeferred();
    const pairing = createDeferred<string>();
    let delayed = false;
    const runtime = createRuntime(() => {
      if (delayed) {
        entered.resolve();
        return pairing.promise;
      }
      return Promise.resolve("generation-a");
    });
    const originalFrames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", originalFrames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    const publisher = liveTextPublisher(runtime, "chat");
    await publisher.send("one", "one");
    delayed = true;
    const pending = publisher.send("one two", " two");
    await entered.promise;
    const replacementFrames: string[] = [];
    registerNode(runtime, "conn-replacement", "generation-a", replacementFrames);
    pairing.resolve("generation-a");
    await pending;
    delayed = false;
    await publisher.send("one two three", " three");
    await publisher.send("one two three four", " four");

    expect(originalFrames).toHaveLength(1);
    expect(replacementFrames.map((frame) => JSON.parse(frame).payload)).toEqual([
      {
        runId: "run-a",
        state: "delta",
        deltaText: " three",
        message: { role: "assistant", content: [{ type: "text", text: "one two three" }] },
      },
      { runId: "run-a", state: "delta", deltaText: " four" },
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
    const entered = createDeferred();
    const pairing = createDeferred<string>();
    let delayed = false;
    let current = true;
    const runtime = createRuntime(() => {
      if (delayed) {
        entered.resolve();
        return pairing.promise;
      }
      return Promise.resolve("generation-a");
    });
    const frames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", frames);
    const sessionKey = "agent:main:main";
    runtime.nodeSubscribe("node-a", sessionKey, "conn-original");
    const publisher = liveTextPublisher(runtime, "agent", sessionKey);
    const chatRunState = createChatRunState();
    chatRunState.getOrCreate("run-a").liveTextGroup = publisher.group;
    await publisher.send("one", "one", { isCurrent: () => current });
    delayed = true;
    const firstTail = publisher.send("one two", " two", { isCurrent: () => current });
    const secondTail = publisher.send("one two three", " three", { isCurrent: () => current });
    await entered.promise;
    if (boundary === "revoked source") {
      current = false;
    }
    if (boundary === "cancel") {
      chatRunState.clearRun("run-a");
    }
    const terminals: Promise<void>[] = [];
    broadcastChatTerminal({
      context: {
        broadcast: vi.fn(),
        agentRunSeq: new Map(),
        chatRunState,
        nodeSendToSession: (...args) => {
          terminals.push(runtime.nodeSendToSession(...args));
        },
      },
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
    pairing.resolve("generation-a");
    await Promise.all([firstTail, secondTail, ...terminals]);

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

  test.each(["tool", "lifecycle"] as const)(
    "drains the queued assistant tail when the source gap arrives on %s",
    async (stream) => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const pairing = createDeferred<string>();
      let delayed = false;
      const runtime = createRuntime(() => {
        if (delayed) {
          entered.resolve();
          return pairing.promise;
        }
        return Promise.resolve("generation-a");
      });
      const frames: string[] = [];
      registerNode(runtime, "conn-original", "generation-a", frames);
      const sessionKey = "agent:main:node-source-gap";
      const runId = "run-source-gap";
      runtime.nodeSubscribe("node-a", sessionKey, "conn-original");
      const chatRunState = createChatRunState();
      const sends: Promise<void>[] = [];
      const handler = createAgentEventHandler({
        broadcast: vi.fn(),
        broadcastToConnIds: vi.fn(),
        nodeSendToSession: (...args) => {
          sends.push(runtime.nodeSendToSession(...args));
        },
        nodeHasSessionSubscribers: runtime.nodeHasSessionSubscribers,
        agentRunSeq: new Map(),
        chatRunState,
        resolveSessionKeyForRun: () => sessionKey,
        clearAgentRunContext: vi.fn(),
        toolEventRecipients: chatRunState.toolEventRecipients,
        sessionEventSubscribers: runtime.sessionEventSubscribers,
        sessionMessageSubscribers: runtime.sessionMessageSubscribers,
        persistGatewaySessionLifecycleEventForEvent: vi.fn(async () => undefined),
      });
      const emit = (
        seq: number,
        eventStream: AgentEventRuntimePayload["stream"],
        data: Record<string, unknown>,
      ) => {
        const event: AgentEventRuntimePayload = {
          runId,
          sessionKey,
          seq,
          ts: seq,
          stream: eventStream,
          data,
          projectSessionLifecycle: false,
          verboseLevel: "full",
        };
        handler(event);
      };
      try {
        emit(1, "assistant", { text: "A", delta: "A" });
        await Promise.all(sends);
        delayed = true;
        emit(2, "assistant", { text: "AB", delta: "B" });
        emit(
          4,
          stream,
          stream === "tool"
            ? { phase: "start", toolCallId: "gap-tool", name: "read" }
            : { phase: "end" },
        );
        await entered.promise;
        pairing.resolve("generation-a");
        await Promise.all(sends);

        const events = frames.map((frame) => JSON.parse(frame));
        const assistant = events.filter(
          (frame) => frame.event === "agent" && frame.payload.stream === "assistant",
        );
        expect(assistant.map((frame) => frame.payload.data.delta)).toEqual(["A", "B"]);
        expect(
          assistant.reduce(
            (text, frame) => frame.payload.data.text ?? text + frame.payload.data.delta,
            "",
          ),
        ).toBe("AB");
        const tailIndex = events.findIndex(
          (frame) => frame.payload.stream === "assistant" && frame.payload.data.delta === "B",
        );
        expect(
          events.findIndex((frame) => frame.event === "agent" && frame.payload.stream === stream),
        ).toBeGreaterThan(tailIndex);
      } finally {
        pairing.resolve("generation-a");
        handler.dispose();
        chatRunState.clear();
        vi.useRealTimers();
      }
    },
  );

  test("publishes pairing-generation transitions to lifecycle consumers", () => {
    const onPairingGenerationChanged = vi.fn();
    const runtime = createGatewayNodeSessionRuntime({
      broadcast: vi.fn(),
      onPairingGenerationChanged,
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    });
    registerNode(runtime, "conn-original", "generation-a", []);
    registerNode(runtime, "conn-replacement", "generation-b", []);

    expect(onPairingGenerationChanged).toHaveBeenCalledWith({
      nodeId: "node-a",
      previousPairingGeneration: "generation-a",
      nextPairingGeneration: "generation-b",
      preserveSessionState: false,
    });
  });

  test("broadcasts and routes runner inventory changes from publication and replacement", () => {
    const order: string[] = [];
    const broadcast = vi.fn((event: string) => {
      order.push(`broadcast:${event}`);
    });
    const onRunnerStateChanged = vi.fn((_nodeId, change) => {
      if (change.availabilityChanged) {
        order.push("availability");
      }
      if (change.inventoryChanged) {
        order.push("inventory");
      }
    });
    const runtime = createRuntime(
      async () => "generation-a",
      broadcast,
      undefined,
      onRunnerStateChanged,
    );
    registerNode(runtime, "conn-original", "generation-a", []);

    expect(
      updateNodeRunnerInventory({
        registry: runtime.nodeRegistry,
        nodeId: "node-a",
        connId: "conn-original",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 1, available: 0 } },
        },
      }),
    ).toEqual({ changed: true });
    expect(broadcast).toHaveBeenNthCalledWith(
      1,
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      "sessions.changed",
      { reason: "runner-availability" },
      { dropIfSlow: true },
    );
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(true);
    expect(onRunnerStateChanged).toHaveBeenLastCalledWith("node-a", {
      inventoryChanged: true,
      availabilityChanged: true,
    });
    expect(order).toEqual([
      "availability",
      "inventory",
      `broadcast:${GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED}`,
      "broadcast:sessions.changed",
    ]);

    registerNode(runtime, "conn-replacement", "generation-a", []);

    expect(broadcast).toHaveBeenCalledTimes(4);
    expect(onRunnerStateChanged).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenNthCalledWith(
      3,
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
    expect(broadcast).toHaveBeenNthCalledWith(
      4,
      "sessions.changed",
      { reason: "runner-availability" },
      { dropIfSlow: true },
    );
    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(false);
    expect(order.slice(4)).toEqual([
      "availability",
      "inventory",
      `broadcast:${GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED}`,
      "broadcast:sessions.changed",
    ]);
  });

  test("does not publish a session availability edge for a capacity-only update", () => {
    const broadcast = vi.fn();
    const onRunnerStateChanged = vi.fn();
    const runtime = createRuntime(
      async () => "generation-a",
      broadcast,
      undefined,
      onRunnerStateChanged,
    );
    registerNode(runtime, "conn-original", "generation-a", []);
    const publish = (available: number) =>
      updateNodeRunnerInventory({
        registry: runtime.nodeRegistry,
        nodeId: "node-a",
        connId: "conn-original",
        declaration: {
          protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
          workerHost: { enabled: true, capacity: { total: 1, available } },
        },
      });

    expect(publish(1)).toEqual({ changed: true });
    broadcast.mockClear();
    onRunnerStateChanged.mockClear();

    expect(publish(0)).toEqual({ changed: true });

    expect(runtime.nodeWorkerSupervisorTransport.hasCurrentRunner("node-a")).toBe(true);
    expect(onRunnerStateChanged).toHaveBeenCalledExactlyOnceWith("node-a", {
      inventoryChanged: true,
      availabilityChanged: false,
    });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      GATEWAY_EVENT_NODE_RUNNER_INVENTORY_CHANGED,
      { nodeId: "node-a" },
      { dropIfSlow: true },
    );
  });

  test("forwards subscribed payload json without parsing it again", async () => {
    const frames: string[] = [];
    const runtime = createRuntime(async () => "generation-a");
    registerNode(runtime, "conn-node-a", "generation-a", frames);
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

  test("fences voice-wake updates by pairing generation while retaining operator broadcasts", async () => {
    let currentPairingGeneration = "generation-a";
    const resolveCurrentPairingGeneration = vi.fn(async () => currentPairingGeneration);
    const broadcast = vi.fn();
    const runtime = createRuntime(
      resolveCurrentPairingGeneration,
      broadcast,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );
    const frames: string[] = [];
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");
    const routing = {
      version: 1 as const,
      defaultTarget: { mode: "current" as const },
      routes: [],
      updatedAtMs: 1,
    };

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    runtime.broadcastVoiceWakeRoutingChanged(routing);
    await vi.waitFor(() => expect(frames).toHaveLength(2));

    currentPairingGeneration = "generation-b";
    runtime.broadcastVoiceWakeChanged(["retired"]);
    runtime.broadcastVoiceWakeRoutingChanged({ ...routing, updatedAtMs: 2 });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));

    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
      { type: "event", event: "voicewake.routing.changed", payload: { config: routing } },
    ]);
    expect(broadcast).toHaveBeenCalledTimes(4);
  });

  test("fences generation-less voice-wake updates by authenticated pairing identity", async () => {
    let pairingExists = true;
    const broadcast = vi.fn();
    const runtime = createGatewayNodeSessionRuntime({
      broadcast,
      resolveCurrentPairingState: async () =>
        pairingExists ? { identity: "identity-a" } : undefined,
      isPairingStateCurrent: (_nodeId, expected) =>
        pairingExists && expected.identity === "identity-a",
      sessionEventSubscribers: createSessionEventSubscriberRegistry(),
      sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
    });
    const frames: string[] = [];
    const socket: TestSocket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn((payload: string) => frames.push(payload)),
      close: vi.fn(),
    };
    const client = makeGatewayWsClient("conn-node-a", socket);
    runtime.nodeRegistry.register(client, { pairingIdentity: "identity-a" });
    const send = vi.spyOn(runtime.nodeRegistry, "sendEventRawForPairingGeneration");

    runtime.broadcastVoiceWakeChanged(["openclaw"]);
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    pairingExists = false;
    runtime.broadcastVoiceWakeChanged(["retired"]);
    await vi.waitFor(() => expect(client.invalidated).toBe(true));

    expect(send).not.toHaveBeenCalled();
    expect(frames.map((frame) => JSON.parse(frame))).toEqual([
      { type: "event", event: "voicewake.changed", payload: { triggers: ["openclaw"] } },
    ]);
    expect(client.invalidated).toBe(true);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  test("does not inherit subscriptions across a replacement pairing generation", async () => {
    let currentPairingGeneration = "generation-a";
    const runtime = createRuntime(
      async () => currentPairingGeneration,
      undefined,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );

    const originalFrames: string[] = [];
    registerNode(runtime, "conn-original", "generation-a", originalFrames);
    runtime.nodeSubscribe("node-a", "main", "conn-original");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    await runtime.nodeSendToSession("main", "chat", { seq: 1 });
    expect(originalFrames).toHaveLength(1);

    currentPairingGeneration = "generation-b";
    await runtime.nodeSendToSession("main", "chat", { seq: 2 });
    expect(runtime.nodeRegistry.get("node-a")).toBeUndefined();
    expect(originalFrames).toHaveLength(1);

    const replacementFrames: string[] = [];
    registerNode(runtime, "conn-replacement", "generation-b", replacementFrames);
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
    runtime.nodeSubscribe("node-a", "retired", "conn-original");
    expect(runtime.nodeHasSessionSubscribers("retired")).toBe(false);
    await runtime.nodeSendToSession("retired", "chat", { seq: 3 });
    expect(replacementFrames).toHaveLength(0);

    runtime.nodeSubscribe("node-a", "main", "conn-replacement");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    await runtime.nodeSendToSession("main", "chat", { seq: 4 });
    expect(replacementFrames).toHaveLength(1);

    const reconnectFrames: string[] = [];
    registerNode(runtime, "conn-reconnect", "generation-b", reconnectFrames);
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    await runtime.nodeSendToSession("main", "chat", { seq: 5 });
    expect(reconnectFrames).toHaveLength(1);

    runtime.nodeUnsubscribeAll("node-a");
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(false);
  });

  test("preserves subscriptions for an exact live pairing generation promotion", async () => {
    let currentPairingGeneration = "generation-a";
    const runtime = createRuntime(
      async () => currentPairingGeneration,
      undefined,
      (_nodeId, expected) =>
        expected.identity === "identity-a" && expected.generation === currentPairingGeneration,
    );
    const frames: string[] = [];
    registerNode(runtime, "conn-node-a", "generation-a", frames);
    runtime.nodeSubscribe("node-a", "main", "conn-node-a");
    currentPairingGeneration = "generation-b";
    expect(
      runtime.nodeRegistry.updateSurface(
        "node-a",
        { commands: [] },
        {
          expectedConnId: "conn-node-a",
          expectedPairingIdentity: "identity-a",
          expectedPairingGeneration: "generation-a",
          nextPairingGeneration: "generation-b",
        },
      ),
    ).not.toBeNull();
    expect(runtime.nodeHasSessionSubscribers("main")).toBe(true);
    await runtime.nodeSendToSession("main", "chat", { ok: true });
    expect(frames).toHaveLength(1);
  });
});
