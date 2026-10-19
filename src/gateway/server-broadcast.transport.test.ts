import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { listSystemPresence } from "../infra/system-presence.js";
import { gatewayFrameSegments } from "./serialized-json.js";
import {
  broadcastFor as broadcaster,
  coalesced,
  createBroadcastPeer,
  eventFrame,
} from "./server-broadcast.test-support.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";
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

const controlledPeer = (connId: string) => createBroadcastPeer(connId);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["rejected", "failed", "drop", "close", "serialization"])(
  "forgets delivery baselines after %s",
  (loss) => {
    vi.useFakeTimers();
    const peer = controlledPeer("lost");
    peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS];
    const onSessionDeliveryLost = vi.fn();
    const { broadcast } = broadcaster([peer], {
      preparePresenceProjection: (presence) => () => presence,
      onSessionDeliveryLost,
    });
    const payload = { presence: listSystemPresence() };
    const publish = (presence: number) =>
      broadcast("presence", payload, { dropIfSlow: true, stateVersion: { presence } });
    publish(1);
    expect(peer.client.presenceSnapshot?.version).toBe(1);
    peer.callbacks.shift()?.();
    if (loss === "rejected") {
      peer.socket.send.mockImplementationOnce(() => {
        throw new Error("rejected send");
      });
    }
    if (loss === "rejected" || loss === "failed") {
      publish(2);
      if (loss === "failed") {
        expect(peer.client.presenceSnapshot?.version).toBe(2);
        peer.complete(new Error("failed send"));
      }
    } else {
      if (loss !== "serialization") {
        peer.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
      }
      broadcast("skills.changed", loss === "serialization" ? 1n : {}, {
        dropIfSlow: loss === "drop",
      });
    }

    expect(peer.client.presenceSnapshot).toBeUndefined();
    expect(onSessionDeliveryLost).toHaveBeenCalledExactlyOnceWith(peer.client);
    expect(peer.frames).toHaveLength(loss === "failed" ? 2 : 1);
    peer.socket.emit("close", 1008, Buffer.from("fixture complete"));
  },
);

it("delivers identity invalidations only to agent identity readers", () => {
  const read = controlledPeer("read");
  const sessionRead = controlledPeer("session-read");
  const admin = controlledPeer("admin");
  const node = controlledPeer("node");
  sessionRead.client.connect.scopes = ["operator.sessions.read"];
  admin.client.connect.scopes = ["operator.admin"];
  node.client.connect.role = "node";
  const { broadcast } = broadcaster([read, sessionRead, admin, node]);

  broadcast("agent.identity.changed", { agentId: "main" });

  const frame = eventFrame("agent.identity.changed", { agentId: "main" });
  expect([read.frames, admin.frames]).toEqual([[frame], [frame]]);
  expect([sessionRead.frames, node.frames]).toEqual([[], []]);
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
  const { broadcastToConnIds } = broadcaster(peers, {
    sessionMessageSubscribers: subscribers,
    canReceiveSessionEvent: (client) => client.connId !== "revoked",
  });

  const payload = { sessionKey: "global", agentId: "work", reason: "reset", ts: 1 };
  broadcastToConnIds("socket.drain", payload, new Set(peers.map((peer) => peer.client.connId)), {
    agentId: "work",
    sessionKeys: ["agent:work:global"],
    dropIfSlow: false,
  });

  expect(selected.frames).toEqual([eventFrame("socket.drain", payload)]);
  expect([other.frames, revoked.frames, node.frames]).toEqual([[], [], []]);
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
  const { broadcast, clients } = broadcaster([legacy, ...unrelated, selected, denied], {
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
  const { broadcastPluginEvent } = broadcaster([read, write, admin]);
  const payload = { text: "synthetic 🦞 update" };

  broadcastPluginEvent("plugin.fixture.changed", payload, "operator.write");

  expect(read.frames).toEqual([]);
  for (const peer of [write, admin]) {
    expect(peer.frames).toEqual([eventFrame("plugin.fixture.changed", payload)]);
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

it("shares the encoded presence frame between equal recipient stamps", () => {
  const peers = ["first", "same"].map(controlledPeer);
  for (const peer of peers) {
    peer.client.preparedRecipientProfileId = "reader";
  }
  const visible = [{ text: "synthetic 🦞 update", ts: 1 }];
  const { broadcast } = broadcaster(peers, {
    preparePresenceProjection: () => () => visible,
  });
  broadcast("presence", { presence: visible });
  const frames = peers.map((peer) => peer.socket.send.mock.lastCall![0]);
  expect(Buffer.isBuffer(frames[0])).toBe(true);
  expect(frames[1]).toBe(frames[0]);
});

it.each([false, true])("encodes session variants once (shared=%s)", (sharedMessage) => {
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
  const { broadcast, broadcastToConnIds } = broadcaster(peers, {
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
    expect(JSON.parse(String(frame))).toEqual(
      eventFrame(
        "session.message",
        variantFor(peer.client.connId),
        peer.client.connId === "ahead" ? 2 : 1,
        { recipientProfileId: peer.client.connId },
      ),
    );
    if (sharedMessage && peer.client.connId !== "roster") {
      const segments = Buffer.isBuffer(frame) ? gatewayFrameSegments(frame) : undefined;
      expect(segments).toContain(messageBytes);
      // Splitting the row from the sequence creates another deflate boundary on the wire.
      expect(String(segments?.at(-1))).toContain('"session":');
      expect(String(segments?.at(-1))).toContain('"seq":');
    }
  }
});

it.each(["replaced", "closed", "close-failed"])("settles slow-consumer closure: %s", (mode) => {
  vi.useFakeTimers();
  const retired = controlledPeer("retired");
  const replacement = controlledPeer("retired");
  retired.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  if (mode === "close-failed") {
    retired.socket.close.mockImplementationOnce(() => {
      throw new Error("close unavailable");
    });
  }
  const { broadcast } = broadcaster([retired]);
  broadcast("tick", {});
  if (mode === "close-failed") {
    expect(retired.socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    return;
  }
  expect(retired.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "slow consumer");
  expect(retired.socket.terminate).not.toHaveBeenCalled();
  if (mode === "closed") {
    retired.socket.emit("close", 1008, Buffer.from("slow consumer"));
  } else {
    retired.client.socket = replacement.client.socket;
  }
  vi.advanceTimersByTime(2 * WEBSOCKET_CLOSE_GRACE_MS);
  expect(retired.socket.terminate).toHaveBeenCalledTimes(mode === "closed" ? 0 : 1);
  expect(replacement.socket.terminate).not.toHaveBeenCalled();
});

it("keeps failed delivery terminal through late callbacks and permits a replacement socket", () => {
  const retired = controlledPeer("replacement");
  const replacement = controlledPeer("replacement");
  const { broadcast, getBufferedAmount } = broadcaster([retired]);
  const owner = new AbortController();
  sendError.mockClear();
  broadcast("tick", {});
  broadcast("tick", {});
  broadcast("tick", {});
  broadcast("chat", { text: "old pending" }, coalesced(owner.signal));
  retired.callbacks[0]!(new Error("transport failed"));
  // A transport may invoke callbacks synchronously before changing readyState.
  broadcast("chat", { text: "after failure" }, coalesced(owner.signal));
  retired.callbacks[1]!();
  retired.callbacks[0]!(new Error("duplicate callback"));
  expect(retired.frames).toHaveLength(3);
  expect(retired.socket.terminate).toHaveBeenCalledOnce();
  expect(getBufferedAmount("replacement")).toBeUndefined();
  expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
  expect(sendError).toHaveBeenCalledOnce();

  retired.client.socket = replacement.client.socket;
  broadcast("chat", { text: "new socket" });
  broadcast("chat", { text: "new pending" }, coalesced(owner.signal));
  retired.callbacks[2]!(new Error("late old failure"));
  replacement.callbacks[0]!();
  expect(replacement.frames).toEqual([
    eventFrame("chat", { text: "new socket" }, 4),
    eventFrame("chat", { text: "new pending" }, 5),
  ]);
  expect(replacement.socket.terminate).not.toHaveBeenCalled();
  replacement.callbacks[1]!();
  expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
});

it.each(["closing", "invalidated"] as const)("resumes after %s peers", (retirement) => {
  const stale = controlledPeer("stale-pressure");
  const healthy = controlledPeer("healthy-pressure");
  const { clients, broadcast, getBufferedAmount } = broadcaster([stale, healthy]);
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
});

it("stops a terminal barrier when its pending flush fails synchronously", () => {
  const peer = controlledPeer("barrier");
  const { broadcast } = broadcaster([peer]);
  const owner = new AbortController();
  broadcast("tick", {});
  broadcast("chat", { text: "pending" }, coalesced(owner.signal));
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
