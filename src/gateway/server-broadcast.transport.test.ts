import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { listSystemPresence } from "../infra/system-presence.js";
import { gatewayFrameSegments } from "./serialized-json.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { TerminalOutputController } from "./terminal/output-flow-control.js";

const sendError = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "gateway/broadcast" ? { ...logger, error: sendError } : logger;
    },
  };
});

function clientFor(connId: string, socket: WebSocket): GatewayWsClient {
  return {
    connId,
    socket,
    connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  };
}

function controlledPeer(connId: string) {
  const callbacks: Array<(error?: Error) => void> = [];
  const frames: Array<{ seq: number; payload: unknown }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as WebSocket["readyState"],
    bufferedAmount: 0,
    close: vi.fn(),
    terminate: vi.fn(),
    send: vi.fn(
      (
        wire: string | Buffer,
        options: { binary: false } | ((error?: Error) => void),
        callback?: (error?: Error) => void,
      ) => {
        frames.push(JSON.parse(String(wire)));
        callbacks.push(typeof options === "function" ? options : callback!);
      },
    ),
  });
  return { client: clientFor(connId, socket as unknown as WebSocket), socket, callbacks, frames };
}

const liveText = (group: AbortSignal) => ({
  group,
  coalesce: { key: "text", merge: (_previous: unknown, next: unknown) => next },
});

describe("broadcast transport retirement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("forgets presence baselines on rejected and asynchronously failed sends", () => {
    const peers = [controlledPeer("rejected"), controlledPeer("failed")];
    for (const { client } of peers) {
      client.connect.caps = [GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS];
    }
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      preparePresenceProjection: (presence) => () => presence,
    });
    const publish = (version: number) =>
      broadcast(
        "presence",
        { presence: listSystemPresence() },
        {
          dropIfSlow: true,
          stateVersion: { presence: version },
        },
      );
    publish(1);
    for (const peer of peers) {
      expect(peer.client.presenceSnapshot?.version).toBe(1);
      peer.callbacks.shift()?.();
    }
    peers[0]!.socket.send.mockImplementationOnce(() => {
      throw new Error("rejected send");
    });
    publish(2);
    expect(peers[0]!.client.presenceSnapshot).toBeUndefined();
    expect(peers[1]!.client.presenceSnapshot?.version).toBe(2);
    peers[1]!.callbacks.shift()?.(new Error("failed send"));
    expect(peers[1]!.client.presenceSnapshot).toBeUndefined();
  });

  it.each(["drop", "close", "serialization"])("forgets delivery baselines after %s", (loss) => {
    vi.useFakeTimers();
    const peer = controlledPeer("lost");
    peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS];
    const onSessionDeliveryLost = vi.fn();
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
      preparePresenceProjection: (presence) => () => presence,
      onSessionDeliveryLost,
    });
    broadcast("presence", { presence: [] }, { stateVersion: { presence: 1 } });
    expect(peer.client.presenceSnapshot?.version).toBe(1);
    peer.callbacks.shift()?.();
    if (loss !== "serialization") {
      peer.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    }

    broadcast("skills.changed", loss === "serialization" ? 1n : {}, {
      dropIfSlow: loss === "drop",
    });

    expect(peer.client.presenceSnapshot).toBeUndefined();
    expect(onSessionDeliveryLost).toHaveBeenCalledExactlyOnceWith(peer.client);
    expect(peer.frames).toHaveLength(1);
    peer.socket.emit("close", 1008, Buffer.from("fixture complete"));
  });

  it("delivers identity invalidations only to agent identity readers", () => {
    const read = controlledPeer("read");
    const sessionRead = controlledPeer("session-read");
    const admin = controlledPeer("admin");
    const node = controlledPeer("node");
    sessionRead.client.connect.scopes = ["operator.sessions.read"];
    admin.client.connect.scopes = ["operator.admin"];
    node.client.connect.role = "node";
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([
        read.client,
        sessionRead.client,
        admin.client,
        node.client,
      ]),
    });

    broadcast("agent.identity.changed", { agentId: "main" });

    for (const peer of [read, admin]) {
      expect(peer.frames).toEqual([
        { type: "event", event: "agent.identity.changed", payload: { agentId: "main" }, seq: 1 },
      ]);
    }
    expect(sessionRead.frames).toEqual([]);
    expect(node.frames).toEqual([]);
  });

  it("keeps drain events on authorized session subscriptions", () => {
    const selected = controlledPeer("selected");
    const other = controlledPeer("other");
    const revoked = controlledPeer("revoked");
    const node = controlledPeer("node");
    const peers = [selected, other, revoked, node];
    const subscribers = createSessionMessageSubscriberRegistry();
    for (const peer of peers) {
      peer.client.connect.scopes = ["operator.sessions.read"];
      peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    node.client.connect.role = "node";
    subscribers.subscribe("selected", "agent:work:global");
    subscribers.subscribe("revoked", "agent:work:global");
    subscribers.subscribe("node", "agent:work:global");
    subscribers.subscribe("other", "agent:main:global");
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map((peer) => peer.client)),
      sessionMessageSubscribers: subscribers,
      canReceiveSessionEvent: (client) => client.connId !== "revoked",
    });

    broadcastToConnIds(
      "socket.drain",
      { sessionKey: "global", agentId: "work", reason: "reset", ts: 1 },
      new Set(peers.map((peer) => peer.client.connId)),
      { agentId: "work", sessionKeys: ["agent:work:global"], dropIfSlow: false },
    );

    expect(selected.frames).toEqual([
      {
        type: "event",
        event: "socket.drain",
        payload: { sessionKey: "global", agentId: "work", reason: "reset", ts: 1 },
        seq: 1,
      },
    ]);
    for (const peer of [other, revoked, node]) {
      expect(peer.frames).toEqual([]);
    }
  });

  it("visits only the session audience and refreshes it through subscription and connection changes", () => {
    const legacy = controlledPeer("legacy");
    const selected = controlledPeer("selected");
    const denied = controlledPeer("denied");
    const unrelated = Array.from({ length: 32 }, (_, index) => controlledPeer(`other-${index}`));
    for (const peer of [selected, denied, ...unrelated]) {
      peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    denied.client.connect.scopes = [];
    const clients = new GatewayClientRegistry([
      legacy.client,
      ...unrelated.map((peer) => peer.client),
      selected.client,
      denied.client,
    ]);
    const subscribers = createSessionMessageSubscriberRegistry();
    for (const key of ["session-a", "session-b"]) {
      subscribers.subscribe("selected", key);
      subscribers.subscribe("denied", key);
    }
    let unrelatedVisits = 0;
    for (const peer of unrelated) {
      Object.defineProperty(peer.socket, "readyState", {
        get: () => {
          unrelatedVisits += 1;
          return WebSocket.OPEN;
        },
      });
    }
    const { broadcast } = createGatewayBroadcaster({
      clients,
      sessionMessageSubscribers: subscribers,
    });
    const publish = () =>
      broadcast("chat", { sessionKey: "session-a" }, { sessionKeys: ["session-a", "session-b"] });

    publish();
    expect(legacy.frames).toHaveLength(1);
    expect(selected.frames).toHaveLength(1);
    expect(denied.frames).toEqual([]);
    expect(unrelatedVisits).toBe(0);

    selected.client.connect.scopes = [];
    publish();
    expect(selected.frames).toHaveLength(1);
    clients.delete(legacy.client);
    subscribers.unsubscribeAll("selected");
    subscribers.unsubscribeAll("denied");
    publish();
    expect(unrelatedVisits).toBe(0);
    expect(legacy.frames).toHaveLength(2);

    clients.delete(selected.client);
    const replacement = controlledPeer("selected");
    clients.add(replacement.client);
    publish();
    expect(replacement.frames).toHaveLength(1);
    clients.clear();
    selected.client.connect.scopes = ["operator.read"];
    clients.add(selected.client);
    publish();
    expect(selected.frames).toHaveLength(1);
    subscribers.subscribe("selected", "session-b");
    publish();
    expect(selected.frames).toHaveLength(2);
  });

  it("shares encoded plugin events only after scope filtering and preserves recipient sequences", () => {
    const read = controlledPeer("read");
    const write = controlledPeer("write");
    const admin = controlledPeer("admin");
    write.client.connect.scopes = ["operator.write"];
    admin.client.connect.scopes = ["operator.admin"];
    const { broadcastPluginEvent } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([read.client, write.client, admin.client]),
    });
    const payload = { text: "synthetic 🦞 update" };

    broadcastPluginEvent("plugin.fixture.changed", payload, "operator.write");

    expect(read.frames).toEqual([]);
    for (const peer of [write, admin]) {
      expect(peer.frames).toEqual([
        { type: "event", event: "plugin.fixture.changed", payload, seq: 1 },
      ]);
      expect(peer.socket.send.mock.calls[0]?.[1]).toEqual({ binary: false });
    }
    const first = write.socket.send.mock.calls[0]![0];
    expect(Buffer.isBuffer(first)).toBe(true);
    expect(admin.socket.send.mock.calls[0]![0]).toBe(first);

    const encode = vi.spyOn(Buffer, "from");
    broadcastPluginEvent("plugin.fixture.changed", payload, "operator.read");
    const payloadEncodings = encode.mock.calls.filter(
      ([value]) => typeof value === "string" && value.includes(payload.text),
    );
    encode.mockRestore();
    expect(payloadEncodings.length).toBeLessThanOrEqual(1);
    expect(read.frames.at(-1)?.seq).toBe(1);
    expect(write.frames.at(-1)?.seq).toBe(2);
    expect(admin.frames.at(-1)?.seq).toBe(2);
    expect(write.socket.send.mock.calls[1]![0]).not.toBe(first);
    expect(admin.socket.send.mock.calls[1]![0]).toBe(write.socket.send.mock.calls[1]![0]);
  });

  it("shares encoded presence only after current recipient projection", () => {
    const peers = ["first", "ahead", "other", "same", "same-again", "revoked"].map(controlledPeer);
    for (const peer of peers) {
      peer.client.preparedRecipientProfileId = peer.client.connId === "other" ? "other" : "reader";
    }
    const visible = [{ text: "synthetic 🦞 update", ts: 1 }];
    const hidden: typeof visible = [];
    let revoked = false;
    const project = vi.fn((client: GatewayWsClient) =>
      client.connId === "revoked" && revoked ? hidden : visible,
    );
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      preparePresenceProjection: () => project,
    });
    broadcastToConnIds("tick", {}, new Set(["ahead"]));
    peers[0]!.socket.send.mockImplementationOnce(() => {
      revoked = true;
    });
    broadcast("presence", { presence: visible });

    const frames = peers.map((peer) => peer.socket.send.mock.lastCall![0]);
    expect(Buffer.isBuffer(frames[0])).toBe(true);
    expect(frames[3]).toBe(frames[0]);
    expect(frames[4]).toBe(frames[0]);
    expect(project).toHaveBeenCalledTimes(6);
    for (const [index, frame] of frames.entries()) {
      expect(JSON.parse(String(frame))).toEqual({
        type: "event",
        event: "presence",
        payload: { presence: index === 5 ? hidden : visible },
        seq: index === 1 ? 2 : 1,
        recipientProfileId: index === 2 ? "other" : "reader",
      });
    }
    visible[0]!.ts = 2;
    broadcast("presence", { presence: visible });
    expect(String(peers[1]!.socket.send.mock.lastCall![0])).toContain('"ts":2');
  });

  it.each([false, true])(
    "encodes session variants once across recipient stamps (shared message: %s)",
    (sharedMessage) => {
      const peers = ["first", "ahead", "restricted", "same", "roster"].map(controlledPeer);
      for (const peer of peers) {
        peer.client.preparedRecipientProfileId = peer.client.connId;
      }
      const message = { text: "synthetic 🦞 message".repeat(100) };
      const messageBytes = Buffer.from(`"message":${JSON.stringify(message)},`);
      const variants = [
        { session: { label: "session-visible" }, message },
        { session: { label: "session-restricted" }, message },
        { session: { label: "session-visible" } },
      ];
      const variantFor = (connId: string) =>
        variants[connId === "restricted" ? 1 : connId === "roster" ? 2 : 0]!;
      const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
        prepareSessionEventProjection: (event) =>
          event === "session.message"
            ? (client) => {
                const payload = variantFor(client.connId);
                return {
                  payload,
                  serializeSession: () => JSON.stringify(payload.session),
                  serializeMessage:
                    sharedMessage && client.connId !== "roster" ? () => messageBytes : undefined,
                };
              }
            : undefined,
      });
      broadcastToConnIds("tick", {}, new Set(["ahead"]));
      const encode = vi.spyOn(Buffer, "from");
      broadcast("session.message", {});
      const rowEncodings = encode.mock.calls.filter(
        ([value]) => typeof value === "string" && value.includes('"label":"session-'),
      );
      encode.mockRestore();

      expect(rowEncodings).toHaveLength(variants.length);
      for (const peer of peers) {
        const frame = peer.socket.send.mock.lastCall![0];
        expect(JSON.parse(String(frame))).toEqual({
          type: "event",
          event: "session.message",
          payload: variantFor(peer.client.connId),
          seq: peer.client.connId === "ahead" ? 2 : 1,
          recipientProfileId: peer.client.connId,
        });
        if (sharedMessage && peer.client.connId !== "roster") {
          const segments = Buffer.isBuffer(frame) ? gatewayFrameSegments(frame) : undefined;
          expect(segments).toContain(messageBytes);
          // Splitting the row from the sequence creates another deflate boundary on the wire.
          expect(String(segments?.at(-1))).toContain('"session":');
          expect(String(segments?.at(-1))).toContain('"seq":');
        }
      }
    },
  );

  it("terminates only the slow socket captured before replacement", () => {
    vi.useFakeTimers();
    const retired = controlledPeer("replacement");
    const replacement = controlledPeer("replacement");
    retired.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([retired.client]),
    });

    broadcast("tick", {});
    expect(retired.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "slow consumer");
    expect(retired.socket.terminate).not.toHaveBeenCalled();

    retired.client.socket = replacement.client.socket;
    vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
    vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);

    expect(retired.socket.terminate).toHaveBeenCalledOnce();
    expect(replacement.socket.terminate).not.toHaveBeenCalled();
  });

  it("cancels the slow-consumer fallback after the socket closes", () => {
    vi.useFakeTimers();
    const retired = controlledPeer("closed");
    retired.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([retired.client]),
    });

    broadcast("tick", {});
    retired.socket.emit("close", 1008, Buffer.from("slow consumer"));
    vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);

    expect(retired.socket.terminate).not.toHaveBeenCalled();
  });

  it("terminates immediately when a slow-consumer close cannot be queued", () => {
    vi.useFakeTimers();
    const retired = controlledPeer("close-failed");
    retired.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    retired.socket.close.mockImplementationOnce(() => {
      throw new Error("close unavailable");
    });
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([retired.client]),
    });

    broadcast("tick", {});

    expect(retired.socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps failed delivery terminal through late callbacks and permits a replacement socket", () => {
    const retired = controlledPeer("replacement");
    const replacement = controlledPeer("replacement");
    const { broadcast, getBufferedAmount } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([retired.client]),
    });
    const owner = new AbortController();
    sendError.mockClear();
    broadcast("tick", {});
    broadcast("tick", {});
    broadcast("tick", {});
    broadcast("chat", { text: "old pending" }, { liveText: liveText(owner.signal) });
    retired.callbacks[0]!(new Error("transport failed"));
    // A transport may invoke callbacks synchronously before changing readyState.
    broadcast("chat", { text: "after failure" }, { liveText: liveText(owner.signal) });
    retired.callbacks[1]!();
    retired.callbacks[0]!(new Error("duplicate callback"));
    expect(retired.frames).toHaveLength(3);
    expect(retired.socket.terminate).toHaveBeenCalledOnce();
    expect(getBufferedAmount("replacement")).toBeUndefined();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
    expect(sendError).toHaveBeenCalledOnce();

    retired.client.socket = replacement.client.socket;
    broadcast("chat", { text: "new socket" });
    broadcast("chat", { text: "new pending" }, { liveText: liveText(owner.signal) });
    retired.callbacks[2]!(new Error("late old failure"));
    replacement.callbacks[0]!();
    expect(replacement.frames).toEqual([
      { type: "event", event: "chat", seq: 4, payload: { text: "new socket" } },
      { type: "event", event: "chat", seq: 5, payload: { text: "new pending" } },
    ]);
    expect(replacement.socket.terminate).not.toHaveBeenCalled();
    replacement.callbacks[1]!();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
  });

  it.each(["closing", "invalidated"] as const)(
    "does not hold healthy terminal viewers paused for a %s peer's stale bytes",
    (retirement) => {
      const stale = controlledPeer("stale-pressure");
      const healthy = controlledPeer("healthy-pressure");
      const clients = new GatewayClientRegistry([stale.client, healthy.client]);
      const { broadcast, getBufferedAmount } = createGatewayBroadcaster({ clients });
      broadcast("tick", {});
      stale.socket.bufferedAmount = 4 * 1024 * 1024;
      const backend = { pause: vi.fn(), resume: vi.fn() };
      const output = new TerminalOutputController({
        backend,
        getConnIds: () => [stale.client.connId, healthy.client.connId],
        getBufferedAmount,
        record: vi.fn(),
        emit: vi.fn(),
      });
      try {
        output.reconcileRecipients();
        expect(backend.pause).toHaveBeenCalledOnce();
        if (retirement === "closing") {
          stale.socket.readyState = WebSocket.CLOSING;
        } else {
          stale.client.invalidated = true;
        }
        expect(clients.has(stale.client)).toBe(true);
        output.reconcileRecipients();
        expect(backend.resume).toHaveBeenCalledOnce();
        expect(getBufferedAmount(stale.client.connId)).toBeUndefined();
      } finally {
        output.dispose();
      }
    },
  );

  it("stops a terminal barrier when its pending flush fails synchronously", () => {
    const peer = controlledPeer("barrier");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([peer.client]),
    });
    const owner = new AbortController();
    broadcast("tick", {});
    broadcast("chat", { text: "pending" }, { liveText: liveText(owner.signal) });
    sendError.mockClear();
    peer.socket.send.mockImplementationOnce((_wire, options, callback) => {
      const error = new Error("flush failed");
      (typeof options === "function" ? options : callback!)(error);
    });

    broadcast("chat", { text: "terminal" }, { liveText: { group: owner.signal } });
    peer.callbacks[0]!();

    expect(peer.socket.send).toHaveBeenCalledTimes(2);
    expect(peer.frames).toHaveLength(1);
    expect(peer.socket.terminate).toHaveBeenCalledOnce();
    expect(sendError).toHaveBeenCalledOnce();
    expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
  });
});
