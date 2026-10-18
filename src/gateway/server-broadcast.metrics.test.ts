import { setImmediate as yieldImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
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

it("batches session frame bytes by reason and exact subscription without changing the wire", async () => {
  const observations: DiagnosticEventPayload[] = [];
  setDiagnosticsEnabledForProcess(true);
  const unsubscribe = onInternalDiagnosticEvent((event) => observations.push(event), {
    include: ["gateway.ws.event"],
  });
  const viewer = makeClient("viewer", "operator", ["operator.read"]);
  const roster = makeClient("roster", "operator", ["operator.read"]);
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe("viewer", "agent:main:global");
  subscribers.subscribe("roster", "agent:main:another-session");
  for (const { client } of [viewer, roster]) {
    client.socket.recordEventSent = recordGatewayWsEvent;
  }
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
  try {
    for (let i = 0; i < 2; i++) {
      broadcastToConnIds("sessions.changed", changed, recipients, {
        sessionEventSubscriptionKeys: ["agent:main:global"],
      });
      broadcastToConnIds("session.message", message, recipients);
    }
    expect(observations).toEqual([]);
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    const changedBytes = [1, 3].reduce(
      (sum, seq) =>
        sum +
        Buffer.byteLength(
          JSON.stringify({
            type: "event",
            event: "sessions.changed",
            payload: changed,
            seq,
          }),
        ),
      0,
    );
    const messageBytes = [2, 4].reduce(
      (sum, seq) =>
        sum +
        Buffer.byteLength(
          JSON.stringify({
            type: "event",
            event: "session.message",
            payload: message,
            seq,
          }),
        ),
      0,
    );
    expect(observations.map(({ seq: _seq, ts: _ts, ...event }) => event)).toEqual([
      {
        type: "gateway.ws.event",
        event: "sessions.changed",
        count: 2,
        bytes: changedBytes,
        sessionEvent: { reason: "agent.run.started", delivery: "subscribed" },
      },
      {
        type: "gateway.ws.event",
        event: "sessions.changed",
        count: 2,
        bytes: changedBytes,
        sessionEvent: { reason: "agent.run.started", delivery: "roster" },
      },
      {
        type: "gateway.ws.event",
        event: "session.message",
        count: 2,
        bytes: messageBytes,
        sessionEvent: { reason: "assistant", delivery: "subscribed" },
      },
      {
        type: "gateway.ws.event",
        event: "session.message",
        count: 2,
        bytes: messageBytes,
        sessionEvent: { reason: "assistant", delivery: "roster" },
      },
    ]);
    expect(viewer.socket.send.mock.calls.map(([frame]) => String(frame))).toEqual(
      roster.socket.send.mock.calls.map(([frame]) => String(frame)),
    );
    expect(String(viewer.socket.send.mock.calls[0]![0])).toBe(
      JSON.stringify({
        type: "event",
        event: "sessions.changed",
        payload: changed,
        seq: 1,
      }),
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
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    expect(
      observations
        .filter((event) => event.type === "gateway.ws.event")
        .map((event) => ({
          event: event.event,
          count: event.count,
          reason: event.sessionEvent?.reason,
          delivery: event.sessionEvent?.delivery,
        })),
    ).toEqual([
      { event: "sessions.changed", count: 2, reason: "end", delivery: "roster" },
      { event: "sessions.changed", count: 2, reason: "other", delivery: "roster" },
      { event: "session.message", count: 2, reason: "other", delivery: "roster" },
      { event: "session.message", count: 2, reason: "message", delivery: "roster" },
    ]);
    expect(JSON.stringify(observations)).not.toMatch(
      /private-reason|private-role|sessionKey|content/,
    );
  } finally {
    unsubscribe();
    setDiagnosticsEnabledForProcess(false);
  }
});

it("batches accepted presence frame counts and UTF-8 bytes by delivery mode", async () => {
  const observations: DiagnosticEventPayload[] = [];
  setDiagnosticsEnabledForProcess(true);
  const unsubscribe = onInternalDiagnosticEvent((event) => observations.push(event), {
    include: ["gateway.ws.event"],
  });
  const capable = makeClient("capable", "operator", ["operator.read"]);
  const legacy = makeClient("legacy", "operator", ["operator.read"]);
  capable.client.connect.caps = [GATEWAY_CLIENT_CAPS.PRESENCE_DELTAS];
  for (const { client } of [capable, legacy]) {
    client.socket.recordEventSent = recordGatewayWsEvent;
  }
  const { broadcast } = createGatewayBroadcaster({
    clients: new GatewayClientRegistry([capable.client, legacy.client]),
    preparePresenceProjection: (presence) => () => presence,
  });
  try {
    const presence = listSystemPresence();
    for (const version of [1, 2, 3]) {
      if (version === 3) {
        capable.client.presenceSnapshot = undefined;
      }
      broadcast("presence", { presence }, { stateVersion: { presence: version } });
    }
    expect(observations).toEqual([]);
    await yieldImmediate();
    await waitForDiagnosticEventsDrained();
    const bytes = (peer: typeof capable, indices: number[]) =>
      indices.reduce(
        (total, index) => total + Buffer.byteLength(peer.socket.send.mock.calls[index]![0]),
        0,
      );
    expect(observations.map(({ seq: _seq, ts: _ts, ...event }) => event)).toEqual([
      {
        type: "gateway.ws.event",
        event: "presence",
        count: 2,
        bytes: bytes(capable, [0, 2]),
        presenceMode: "reset",
      },
      {
        type: "gateway.ws.event",
        event: "presence",
        count: 3,
        bytes: bytes(legacy, [0, 1, 2]),
        presenceMode: "legacy",
      },
      {
        type: "gateway.ws.event",
        event: "presence",
        count: 1,
        bytes: bytes(capable, [1]),
        presenceMode: "delta",
      },
    ]);
  } finally {
    unsubscribe();
    setDiagnosticsEnabledForProcess(false);
  }
});
