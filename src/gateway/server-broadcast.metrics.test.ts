import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it, onTestFinished } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import {
  onInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { listSystemPresence } from "../infra/system-presence.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { recordGatewayWsEvent } from "./server/ws-connection-diagnostics.js";

function observeTraffic() {
  const observations: DiagnosticEventPayload[] = [];
  setDiagnosticsEnabledForProcess(true);
  const unsubscribe = onInternalDiagnosticEvent((event) => observations.push(event), {
    include: ["gateway.ws.event"],
  });
  onTestFinished(() => {
    unsubscribe();
    setDiagnosticsEnabledForProcess(false);
  });
  return observations;
}

function traffic(observations: DiagnosticEventPayload[], includeHistogram = false) {
  return observations.map(({ seq: _seq, ts: _ts, ...event }) => {
    if (event.type === "gateway.ws.event" && !includeHistogram) {
      const { frameBytes: _frameBytes, ...rest } = event;
      return rest;
    }
    return event;
  });
}

const histogram = (counts: number[]) =>
  Object.fromEntries(
    ["256", "512", "1024", "2048", "4096", "8192", "16384", "65536", "+Inf"].map((bound, index) => [
      bound,
      counts[index],
    ]),
  );

function recordingClient(id: string) {
  const peer = makeClient(id, "operator", ["operator.read"]);
  peer.client.socket.recordEventSent = (event, frame, sessionEvent, presenceMode) =>
    recordGatewayWsEvent(event, frame.byteLength, sessionEvent, presenceMode);
  return peer;
}

async function drain() {
  await yieldImmediate();
  await waitForDiagnosticEventsDrained();
}

const wireFrame = (event: string, payload: unknown, seq: number) =>
  JSON.stringify({ type: "event", event, payload, seq });
const frameBytes = (event: string, payload: unknown, seqs: number[]) =>
  seqs.reduce((sum, seq) => sum + Buffer.byteLength(wireFrame(event, payload, seq)), 0);

it("batches session frame bytes by reason and exact subscription", async () => {
  const observations = observeTraffic();
  const viewer = recordingClient("viewer");
  const roster = recordingClient("roster");
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe("viewer", "agent:main:global");
  subscribers.subscribe("roster", "agent:main:another-session");
  const { broadcastToConnIds } = createGatewayBroadcaster({
    clients: new GatewayClientRegistry([viewer.client, roster.client]),
    sessionMessageSubscribers: subscribers,
  });
  const recipients = new Set(["viewer", "roster"]);
  const changed = { sessionKey: "global", reason: "agent.run.started", label: "é🦞" };
  const message = {
    sessionKey: "agent:main:global",
    message: { role: "assistant", content: "é🦞" },
  };
  for (let i = 0; i < 2; i++) {
    broadcastToConnIds("sessions.changed", changed, recipients, {
      sessionEventSubscriptionKeys: ["agent:main:global"],
    });
    broadcastToConnIds("session.message", message, recipients);
  }
  expect(observations).toEqual([]);
  await drain();
  expect(traffic(observations)).toEqual(
    [
      ["sessions.changed", "agent.run.started", frameBytes("sessions.changed", changed, [1, 3])],
      ["session.message", "assistant", frameBytes("session.message", message, [2, 4])],
    ].flatMap(([event, reason, bytes]) =>
      ["subscribed", "roster"].map((delivery) => ({
        type: "gateway.ws.event",
        event,
        count: 2,
        bytes,
        sessionEvent: { reason, delivery },
      })),
    ),
  );
  observations.length = 0;
  for (const [event, payload] of [
    ["sessions.changed", { phase: "end" }],
    ["sessions.changed", { reason: "private-reason", phase: "start" }],
    ["session.message", { message: { role: "private-role" } }],
    ["session.message", {}],
  ] as const) {
    broadcastToConnIds(event, payload, recipients);
  }
  await drain();
  expect(traffic(observations)).toMatchObject([
    { event: "sessions.changed", count: 2, sessionEvent: { reason: "end", delivery: "roster" } },
    { event: "sessions.changed", count: 2, sessionEvent: { reason: "other", delivery: "roster" } },
    { event: "session.message", count: 2, sessionEvent: { reason: "other", delivery: "roster" } },
    { event: "session.message", count: 2, sessionEvent: { reason: "message", delivery: "roster" } },
  ]);
  expect(JSON.stringify(observations)).not.toMatch(
    /private-reason|private-role|sessionKey|content/,
  );
});

it("batches accepted presence frame counts and UTF-8 bytes by delivery mode", async () => {
  const observations = observeTraffic();
  const capable = recordingClient("capable");
  const legacy = recordingClient("legacy");
  capable.client.connect.caps = [GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS];
  const { broadcast } = createGatewayBroadcaster({
    clients: new GatewayClientRegistry([capable.client, legacy.client]),
    preparePresenceProjection: (presence) => () => presence,
  });
  const presence = listSystemPresence();
  for (const version of [1, 2, 3]) {
    if (version === 3) {
      capable.client.presenceSnapshot = undefined;
    }
    broadcast("presence", { presence }, { stateVersion: { presence: version } });
  }
  expect(observations).toEqual([]);
  await drain();
  const bytes = (peer: typeof capable, indices: number[]) =>
    indices.reduce(
      (total, index) => total + Buffer.byteLength(String(peer.socket.send.mock.calls[index]![0])),
      0,
    );
  expect(traffic(observations)).toEqual(
    [
      { presenceMode: "reset", count: 2, bytes: bytes(capable, [0, 2]) },
      { presenceMode: "legacy", count: 3, bytes: bytes(legacy, [0, 1, 2]) },
      { presenceMode: "delta", count: 1, bytes: bytes(capable, [1]) },
    ].map((event) => Object.assign({ type: "gateway.ws.event", event: "presence" }, event)),
  );
});

it("preserves histogram boundaries, wire-only batches, and detached snapshots across flushes", async () => {
  setDiagnosticsEnabledForProcess(true);
  expect(recordGatewayWsEvent("chat", 1)).toBe(false);
  const observations = observeTraffic();
  setDiagnosticsEnabledForProcess(false);
  expect(recordGatewayWsEvent("chat", 1)).toBe(false);
  setDiagnosticsEnabledForProcess(true);

  for (const bytes of [256, 257, 1024, 65537]) {
    expect(recordGatewayWsEvent("chat", bytes)).toBe(true);
  }
  recordGatewayWsEvent("chat", 0, undefined, undefined, 0);
  recordGatewayWsEvent("not-a-protocol-event", 0, undefined, undefined, 13);
  recordGatewayWsEvent("another-private-event", 0, undefined, undefined, 7);
  expect(observations).toEqual([]);
  await drain();
  const firstBatch = traffic(observations, true);
  expect(firstBatch).toEqual([
    {
      type: "gateway.ws.event",
      event: "chat",
      count: 4,
      bytes: 67074,
      wireBytes: 0,
      frameBytes: histogram([1, 2, 3, 3, 3, 3, 3, 3, 4]),
    },
    { type: "gateway.ws.event", event: "other", count: 0, bytes: 0, wireBytes: 20 },
  ]);

  recordGatewayWsEvent("not-a-protocol-event", 512);
  recordGatewayWsEvent("chat", 0, undefined, undefined, 99);
  await drain();
  expect(traffic(observations.slice(2), true)).toEqual([
    {
      type: "gateway.ws.event",
      event: "other",
      count: 1,
      bytes: 512,
      frameBytes: histogram([0, 1, 1, 1, 1, 1, 1, 1, 1]),
    },
    { type: "gateway.ws.event", event: "chat", count: 0, bytes: 0, wireBytes: 99 },
  ]);
  expect(traffic(observations.slice(0, 2), true)).toEqual(firstBatch);
});
