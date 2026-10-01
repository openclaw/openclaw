import { EventEmitter, getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createGatewayBroadcaster } from "./server-broadcast.js";
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
    vi.useRealTimers();
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

    broadcastPluginEvent("plugin.fixture.changed", payload, "operator.read");
    expect(read.frames.at(-1)?.seq).toBe(1);
    expect(write.frames.at(-1)?.seq).toBe(2);
    expect(admin.frames.at(-1)?.seq).toBe(2);
    expect(write.socket.send.mock.calls[1]![0]).not.toBe(first);
    expect(admin.socket.send.mock.calls[1]![0]).toBe(write.socket.send.mock.calls[1]![0]);
  });

  it("shares complete session frames only after each recipient's projection and delivery checks", () => {
    const peers = ["first", "same", "model", "ancestor", "profile", "sequence", "revoked"].map(
      controlledPeer,
    );
    for (const peer of peers) {
      peer.client.preparedRecipientProfileId = "profile-a";
    }
    const replacement = controlledPeer("same");
    const delivered = vi.fn();
    const authorize = vi.fn(() => true);
    const row = { key: "agent:main:shared", model: "visible-model" };
    const project = vi.fn((client: GatewayWsClient) => ({
      payload: {
        session: client.connId === "model" ? { ...row, model: "other-model" } : row,
        ancestorSessionRefs: [
          { key: "agent:main:parent", revision: client.connId === "ancestor" ? "other" : "held" },
        ],
      },
      delivered: () => delivered(client.connId),
    }));
    const { broadcast, broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(peers.map(({ client }) => client)),
      canReceiveSessionEvent: authorize,
      prepareSessionEventProjection: (event) => (event === "session.message" ? project : undefined),
    });
    broadcastToConnIds("tick", {}, new Set(["sequence"]));
    for (const peer of peers) {
      peer.socket.send.mockClear();
      peer.frames.length = 0;
    }
    const send = peers[0]!.socket.send.getMockImplementation()!;
    peers[0]!.socket.send.mockImplementationOnce((...args) => {
      expect(delivered).toHaveBeenCalledExactlyOnceWith("first");
      send(...args);
      peers[1]!.client.socket = replacement.client.socket;
      peers[4]!.client.preparedRecipientProfileId = "profile-b";
      peers[6]!.client.invalidated = true;
    });

    broadcast("session.message", { sessionKey: row.key });

    const first = peers[0]!.socket.send.mock.calls[0]![0];
    expect(Buffer.isBuffer(first)).toBe(true);
    expect(replacement.socket.send.mock.calls[0]![0]).toBe(first);
    expect(peers[1]!.socket.send).not.toHaveBeenCalled();
    for (const peer of peers.slice(2, 6)) {
      expect(peer.socket.send.mock.calls[0]![0]).not.toBe(first);
      expect(peer.socket.send.mock.calls[0]![1]).toEqual({ binary: false });
    }
    expect(peers[2]!.frames[0]?.payload).toMatchObject({ session: { model: "other-model" } });
    expect(peers[3]!.frames[0]?.payload).toMatchObject({
      ancestorSessionRefs: [{ revision: "other" }],
    });
    expect(peers[4]!.frames[0]).toMatchObject({ recipientProfileId: "profile-b", seq: 1 });
    expect(peers[5]!.frames[0]?.seq).toBe(2);
    expect(peers[6]!.socket.send).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledTimes(6);
    expect(project).toHaveBeenCalledTimes(6);
    expect(delivered.mock.calls.flat()).toEqual([
      "first",
      "same",
      "model",
      "ancestor",
      "profile",
      "sequence",
    ]);
  });

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
