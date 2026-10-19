import { getEventListeners } from "node:events";
import { expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  getLatestWebSocket,
  MockWebSocket,
  stubWindowGlobals,
  useNodeFakeTimers,
  wsInstances,
} from "../../ui/src/api/gateway-socket.test-support.js";
import { GatewayBrowserClient } from "../../ui/src/api/gateway.js";
import {
  broadcastFor as broadcaster,
  coalesced,
  createBroadcastPeer,
  eventFrame,
} from "./server-broadcast.test-support.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { MAX_BUFFERED_BYTES, WEBSOCKET_CLOSE_GRACE_MS } from "./server-constants.js";

type TextPayload = { sessionKey: string; text: string; delta?: string };
const createPeer = createBroadcastPeer<TextPayload>;

function createBufferedPeer(connId: string, bufferedAmount: number) {
  const peer = createPeer(connId);
  const send = peer.socket.send.getMockImplementation()!;
  peer.socket.bufferedAmount = bufferedAmount;
  peer.socket.send.mockImplementation((wire, options, callback) => {
    const bytes = Buffer.byteLength(wire);
    peer.socket.bufferedAmount += bytes + (bytes < 126 ? 2 : bytes < 65536 ? 4 : 10);
    send(wire, options, callback);
  });
  return peer;
}

const mergeText = (previous: unknown, next: unknown): TextPayload => ({
  ...(next as TextPayload),
  delta: ((previous as TextPayload).delta ?? "") + ((next as TextPayload).delta ?? ""),
});
const text = (value: string, delta?: string): TextPayload => ({
  sessionKey: "agent:main:stream",
  text: value,
  ...(delta === undefined ? {} : { delta }),
});
const textProjection = {
  key: "text",
  delta: (payload: unknown) => {
    const value = payload as TextPayload;
    return { sessionKey: value.sessionKey, delta: value.delta };
  },
  snapshotBytes: (payload: unknown, deltaPayloadBytes: number) =>
    deltaPayloadBytes + Buffer.byteLength(',"text":""') + (payload as TextPayload).text.length * 6,
};

const textOptions = (group: AbortSignal) => ({
  liveText: {
    ...coalesced(group, "text", mergeText).liveText,
    projection: { ...textProjection },
  },
});
const deltaPayload = (value: string) => ({ sessionKey: "agent:main:stream", delta: value });

function harness(peer = createPeer("subscriber"), options: Parameters<typeof broadcaster>[1] = {}) {
  const owner = new AbortController();
  const api = broadcaster([peer], options);
  const opts = textOptions(owner.signal);
  return {
    ...api,
    peer,
    owner,
    opts,
    buffered: () => api.getBufferedAmount(peer.client.connId),
    send: (value: string, delta?: string) => api.broadcast("chat", text(value, delta), opts),
  };
}

const payloads = (peer: ReturnType<typeof createPeer>) => peer.frames.map(({ payload }) => payload);

it("keeps a shared chat stream when one full observer unsubscribes", async () => {
  useNodeFakeTimers();
  stubWindowGlobals();
  vi.stubGlobal("WebSocket", MockWebSocket);
  const onEvent = vi.fn();
  const client = new GatewayBrowserClient({ url: "ws://127.0.0.1:18789", onEvent });
  client.start();
  const ws = getLatestWebSocket();
  ws.emitOpen();
  const peer = createPeer("shared-observers", true);
  peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
  const send = peer.socket.send.getMockImplementation()!;
  peer.socket.send.mockImplementation((frame, options, callback) => {
    send(frame, options, callback);
    ws.emitMessage(String(frame));
  });
  const subscribers = createSessionMessageSubscriberRegistry();
  const { broadcast } = broadcaster([peer], {
    sessionMessageSubscribers: subscribers,
  });
  const sessionKey = "agent:main:chat";
  const owner = new AbortController();
  const assistant = (content: string) => ({ role: "assistant", content });
  const requestObserver = async (method: "subscribe" | "unsubscribe", subscriptionId: string) => {
    const pending = client.request(`sessions.messages.${method}`, {
      key: sessionKey,
      subscriptionId,
    });
    const { id, params } = JSON.parse(ws.sent.at(-1) ?? "{}");
    if (method === "subscribe") {
      subscribers.subscribe(peer.client.connId, params.key, {
        subscriptionId: params.subscriptionId,
      });
    } else {
      subscribers.unsubscribe(peer.client.connId, params.key, params.subscriptionId);
    }
    ws.emitMessage({ type: "res", id, ok: true });
    await pending;
  };
  const publish = (content: string, deltaText: string) => {
    const payload = { sessionKey, runId: "run-1", state: "delta", deltaText };
    const liveText = { group: owner.signal, projection: { key: "chat", delta: () => payload } };
    broadcast("chat", { ...payload, message: assistant(content) }, { liveText });
  };
  try {
    await requestObserver("subscribe", "first");
    await requestObserver("subscribe", "second");
    publish("A", "A");
    await requestObserver("unsubscribe", "first");
    publish("AB", "B");
    expect(onEvent.mock.lastCall?.[0].payload.message).toEqual(assistant("AB"));
    await requestObserver("unsubscribe", "second");
    publish("ABC", "C");
    expect(onEvent).toHaveBeenCalledTimes(2);
    await requestObserver("subscribe", "third");
    publish("ABCD", "D");
    expect(onEvent.mock.lastCall?.[0].payload.message).toEqual(assistant("ABCD"));
    expect(ws.lastClose).toBeNull();
  } finally {
    owner.abort();
    client.stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    wsInstances.length = 0;
  }
});

it("sends one baseline per recipient and concatenates blocked appends without repeating it", () => {
  const slow = createPeer("slow");
  const fast = createPeer("fast", true);
  const late = createPeer("late", true);
  const onBroadcast = vi.fn();
  const { broadcast, clients } = broadcaster([slow, fast], { onBroadcast });
  const owner = new AbortController();
  const opts = textOptions(owner.signal);
  broadcast("chat", text("A", "A"), opts);
  broadcast("chat", text("AB", "B"), opts);
  clients.add(late.client);
  broadcast("chat", text("ABC", "C"), opts);
  broadcast("chat", text("ABCD", "D"), opts);
  slow.complete();
  expect(payloads(slow)).toEqual([text("A", "A"), deltaPayload("BCD")]);
  expect(payloads(fast)).toEqual([text("A", "A"), ...["B", "C", "D"].map(deltaPayload)]);
  expect(payloads(late)).toEqual([text("ABC", "C"), deltaPayload("D")]);
  expect(slow.frames.map(({ seq }) => seq)).toEqual([1, 2]);
  expect(onBroadcast.mock.calls.map(([, payload]) => payload)).toEqual(
    ["A", "AB", "ABC", "ABCD"].map((value) => text(value, value.at(-1))),
  );
  owner.abort();
  expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
});

it("repairs the baseline after dropped output without hiding the sequence gap", () => {
  const { peer, broadcast, owner, opts: streamOpts } = harness(createPeer("subscriber", true));
  const opts = { ...streamOpts, dropIfSlow: true };
  broadcast("chat", text("A", "A"), opts);
  peer.socket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
  broadcast("chat", text("AB", "B"), opts);
  peer.socket.bufferedAmount = 0;
  broadcast("chat", text("ABC", "C"), opts);
  expect(peer.frames.at(-1)?.payload).toEqual(text("ABC", "C"));
  expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 3]);
  owner.abort();
});

it("flushes appends before rewrite and tool barriers, snapshots canvas changes, and retires abort progress", () => {
  const { peer, broadcast, owner, opts, send } = harness();
  const { liveText } = opts;
  send("A", "A");
  send("AB", "B");
  broadcast("agent", text("tool"), { liveText: { group: owner.signal } });
  broadcast("chat", text("replacement", "replacement"), {
    liveText: { group: owner.signal, projection: { ...textProjection, snapshot: true } },
  });
  send("replacement!", "!");
  const canvasVersion = {};
  broadcast("chat", text("replacement!!", "!"), {
    liveText: { ...liveText, projection: { ...textProjection, version: canvasVersion } },
  });
  broadcast("chat", text("final"), { liveText: { group: owner.signal } });
  expect(payloads(peer)).toEqual([
    text("A", "A"),
    deltaPayload("B"),
    text("tool"),
    text("replacement", "replacement"),
    text("replacement!!", "!!"),
    text("final"),
  ]);
  send("stale", "stale");
  owner.abort();
  broadcast("chat", text("aborted"), { liveText: { group: owner.signal } });
  for (let i = 0; i < 7; i += 1) {
    peer.complete();
  }
  expect(peer.frames.at(-1)?.payload).toEqual(text("aborted"));
  expect(peer.frames).toHaveLength(7);
  expect(getEventListeners(owner.signal, "abort")).toHaveLength(0);
});

it("reserves a blocked snapshot without encoding it until subscription recovery needs it", () => {
  const peer = createPeer("blocked");
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe(peer.client.connId, "agent:main:stream");
  const { broadcast, buffered, owner, opts } = harness(peer, {
    sessionMessageSubscribers: subscribers,
  });
  const snapshotJSON = vi.fn((value: string) => ({ content: value }));
  const payload = (value: string, delta: string) => ({
    ...text(value, delta),
    message: { toJSON: () => snapshotJSON(value) },
  });
  opts.liveText.projection.snapshotBytes = (value, deltaPayloadBytes) =>
    deltaPayloadBytes + 100 + (value as TextPayload).text.length * 12;
  broadcast("chat", payload("A", "A"), opts);
  broadcast("chat", payload('AB\\\n"🦞', 'B\\\n"🦞'), opts);
  broadcast("chat", payload('AB\\\n"🦞C', "C"), opts);
  const reserved = buffered()!;
  expect(snapshotJSON).toHaveBeenCalledTimes(1);
  subscribers.unsubscribe(peer.client.connId, "agent:main:stream");
  subscribers.subscribe(peer.client.connId, "agent:main:stream");
  peer.complete();
  expect(snapshotJSON).toHaveBeenCalledTimes(2);
  expect(peer.frames.at(-1)?.payload).toMatchObject({
    text: 'AB\\\n"🦞C',
    message: { content: 'AB\\\n"🦞C' },
  });
  expect(Buffer.byteLength(JSON.stringify(peer.frames.at(-1))) + 10).toBeLessThanOrEqual(reserved);
  expect(buffered()).toBe(0);
  owner.abort();
});

it.each([
  "owner",
  "membership",
  "invalidated",
  "replacement client",
  "scope",
  "throwing visibility",
  "targeted subscription",
] as const)("rechecks current %s before a pending send", (revoked) => {
  const peer = createPeer("subscriber");
  const targeted = revoked === "targeted subscription";
  if (!targeted) {
    peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
  }
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe(peer.client.connId, "agent:main:stream");
  let current = true;
  let visible = true;
  const { clients, broadcast, broadcastToConnIds } = broadcaster([peer], {
    sessionMessageSubscribers: subscribers,
    canReceiveSessionEvent: () => {
      if (!visible && revoked === "throwing visibility") {
        throw new Error("permission retired");
      }
      return visible;
    },
  });
  const opts = coalesced(new AbortController().signal, "text", mergeText);
  const liveOpts = { liveText: { ...opts.liveText, isCurrent: () => current } };
  const publish = (payload: TextPayload) =>
    targeted
      ? broadcastToConnIds("agent", payload, new Set([peer.client.connId]), {
          ...liveOpts,
          sessionSubscriptionVerified: true,
        })
      : broadcast("agent", payload, liveOpts);
  publish(text("A", "A"));
  publish(text("AB", "B"));
  expect(peer.frames).toHaveLength(1);
  const revoke = {
    owner: () => (current = false),
    membership: () => clients.delete(peer.client),
    invalidated: () => (peer.client.invalidated = true),
    "replacement client": () => {
      clients.delete(peer.client);
      clients.add(createPeer("replacement").client);
    },
    scope: () => (peer.client.connect.scopes = []),
    "throwing visibility": () => (visible = false),
    "targeted subscription": () => subscribers.unsubscribe(peer.client.connId, "agent:main:stream"),
  };
  revoke[revoked]();
  peer.complete();
  expect(peer.frames).toHaveLength(1);
});

it("releases a retired group's reservations before a held writer admits its successor", () => {
  const peers = Array.from({ length: 32 }, (_, index) =>
    createBufferedPeer(`retirement-${index}`, MAX_BUFFERED_BYTES - 16384),
  );
  const first = peers[0]!;
  const { broadcast, getBufferedAmount } = broadcaster(peers);
  const retired = new AbortController();
  const sibling = new AbortController();
  broadcast("tick", {});
  broadcast("chat", text("retired".repeat(1024)), coalesced(retired.signal));
  const retiredBytes = getBufferedAmount(first.client.connId)! - first.socket.bufferedAmount;
  broadcast("chat", text("sibling".repeat(256)), coalesced(sibling.signal));
  broadcast("tick", { text: "written".repeat(1200) });
  const before = getBufferedAmount(first.client.connId)!;
  expect(before).toBeGreaterThan(MAX_BUFFERED_BYTES);
  expect(first.socket.bufferedAmount).toBeLessThan(MAX_BUFFERED_BYTES);

  retired.abort();
  for (const peer of peers) {
    expect(getBufferedAmount(peer.client.connId)).toBe(before - retiredBytes);
    expect(getBufferedAmount(peer.client.connId)).toBeGreaterThan(peer.socket.bufferedAmount);
  }
  broadcast("chat", text("aborted"), { liveText: { group: retired.signal } });
  broadcast("chat", text("stale"), coalesced(retired.signal));
  broadcast("chat", text("successor final"));
  for (const peer of peers) {
    expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
    peer.socket.bufferedAmount = 0;
    for (let index = 0; index < 5; index += 1) {
      peer.complete();
    }
    expect(peer.frames.slice(2).map(({ payload }) => payload.text)).toEqual([
      "aborted",
      "successor final",
      "sibling".repeat(256),
    ]);
    expect(peer.frames.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
    expect(peer.socket.close).not.toHaveBeenCalled();
    expect(peer.socket.terminate).not.toHaveBeenCalled();
  }
  sibling.abort();
});

it("does not merge a revoked owner's pending delta into its replacement", () => {
  const { peer, broadcast, owner } = harness();
  const group = owner.signal;
  const opts = coalesced(group, "agent", mergeText);
  let current = true;
  const original = { liveText: { ...opts.liveText, isCurrent: () => current } };
  broadcast("agent", text("A", "A"), original);
  broadcast("agent", text("AB", "B"), original);
  expect(peer.frames).toHaveLength(1);
  current = false;
  broadcast("agent", text("fresh", "fresh"), {
    liveText: { ...opts.liveText, isCurrent: () => true },
  });
  peer.complete();
  expect(peer.frames.at(-1)).toEqual(eventFrame("agent", text("fresh", "fresh"), 2));
});

it("reserves a complete queued message and refreshes recipient projection when it drains", () => {
  const payload = {
    sessionKey: "agent:main:stream",
    message: { content: "A".repeat(4096) },
  };
  let sharingRole = "owner";
  const delivered = vi.fn();
  const { peer, broadcast, buffered, owner } = harness(undefined, {
    prepareSessionEventProjection: (event, value) => {
      if (event !== "session.message") {
        return undefined;
      }
      const source = value as typeof payload;
      return () => ({ payload: { ...source, session: { sharingRole } }, delivered });
    },
  });
  const stateVersion = { presence: 7 };
  const opts = {
    stateVersion,
    ...coalesced(owner.signal, "message"),
  };
  broadcast("tick", {});
  broadcast("session.message", payload, opts);
  const originalBytes = buffered()!;
  expect(originalBytes).toBeGreaterThan(Buffer.byteLength(JSON.stringify(payload)));
  const replacement = { ...payload, message: { content: "B".repeat(2048) } };
  broadcast("session.message", replacement, opts);
  expect(buffered()).toBeLessThan(originalBytes);
  expect(buffered()).toBeGreaterThan(Buffer.byteLength(JSON.stringify(replacement)));
  expect(peer.frames).toHaveLength(1);
  expect(delivered).not.toHaveBeenCalled();

  sharingRole = "viewer";
  peer.client.preparedRecipientProfileId = "current-profile";
  peer.complete();

  expect(peer.frames.at(-1)).toEqual(
    eventFrame("session.message", { ...replacement, session: { sharingRole: "viewer" } }, 2, {
      stateVersion,
      recipientProfileId: "current-profile",
    }),
  );
  expect(buffered()).toBe(0);
  expect(delivered).toHaveBeenCalledOnce();
});

it.each([false, true])("budgets sibling bytes (droppable=%s)", (dropIfSlow) => {
  vi.useFakeTimers();
  const delivered = vi.fn();
  const { peer, broadcast, owner } = harness(
    createBufferedPeer("sibling-pressure", MAX_BUFFERED_BYTES - 8192),
    {
      prepareSessionEventProjection: (event, payload) =>
        event === "session.message" ? () => ({ payload, delivered }) : undefined,
    },
  );
  broadcast("tick", {});
  broadcast("chat", text("A".repeat(4096)), coalesced(owner.signal));
  broadcast("tick", { text: "B".repeat(4096) });
  expect(peer.frames).toHaveLength(2);
  expect(peer.socket.bufferedAmount).toBeLessThan(MAX_BUFFERED_BYTES);

  broadcast("session.message", { marker: "over shared budget" }, { dropIfSlow });

  expect(peer.frames).toHaveLength(2);
  expect(delivered).not.toHaveBeenCalled();
  if (dropIfSlow) {
    expect(peer.socket.close).not.toHaveBeenCalled();
    expect(peer.socket.terminate).not.toHaveBeenCalled();
    peer.socket.bufferedAmount = 0;
    peer.complete();
    peer.complete();
    expect(peer.frames.at(-1)).toMatchObject({ seq: 4, payload: text("A".repeat(4096)) });
  } else {
    expect(peer.socket.close).toHaveBeenCalledWith(1008, "slow consumer");
    expect(peer.socket.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
    expect(peer.socket.terminate).toHaveBeenCalledOnce();
  }
  vi.useRealTimers();
});

it("preserves slow-consumer closure after flushing coalesced output", () => {
  vi.useFakeTimers();
  const { peer, broadcast, owner } = harness(
    createBufferedPeer("backlogged", MAX_BUFFERED_BYTES - 4096),
  );
  const group = owner.signal;
  const payload = text("x".repeat(3072));
  broadcast("tick", {});
  for (const key of ["first", "second"]) {
    broadcast("agent", payload, coalesced(group, key));
  }
  broadcast("chat", text("final"), { liveText: { group } });

  expect(peer.frames.map(({ event, seq }) => [event, seq])).toEqual([
    ["tick", 1],
    ["agent", 2],
    ["agent", 3],
  ]);
  expect(peer.socket.bufferedAmount).toBeGreaterThan(MAX_BUFFERED_BYTES);
  expect(peer.socket.close).toHaveBeenCalledExactlyOnceWith(1008, "slow consumer");
  expect(peer.socket.terminate).not.toHaveBeenCalled();
  vi.advanceTimersByTime(WEBSOCKET_CLOSE_GRACE_MS);
  expect(peer.socket.terminate).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
