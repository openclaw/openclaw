// Real Gateway WebSocket proof for RPC envelopes, discovery, and event ordering.
import { once } from "node:events";
import { afterAll, beforeAll, expect, test } from "vitest";
import { WebSocket } from "ws";
import { emitHeartbeatEvent } from "../infra/heartbeat-events.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import {
  connectReq,
  installGatewayTestHooks,
  onceMessage,
  trackConnectChallengeNonce,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type WireFrame = {
  type?: string;
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: Record<string, unknown> | null;
  seq?: number;
};

let harness: GatewayServerHarness;

beforeAll(async () => {
  harness = await startGatewayServerHarness();
});

afterAll(async () => {
  await harness.close();
});

async function openWireClient() {
  const ws = new WebSocket(`ws://127.0.0.1:${harness.port}`);
  trackConnectChallengeNonce(ws);
  const challengePromise = onceMessage<WireFrame>(
    ws,
    (frame) => frame.type === "event" && frame.event === "connect.challenge",
  );
  await once(ws, "open");
  const challenge = await challengePromise;
  expect(challenge).toMatchObject({
    type: "event",
    event: "connect.challenge",
    payload: {
      nonce: expect.any(String),
      ts: expect.any(Number),
    },
  });
  expect(challenge).not.toHaveProperty("id");
  expect(await connectReq(ws)).toMatchObject({
    type: "res",
    id: expect.any(String),
    ok: true,
    payload: {
      type: "hello-ok",
      protocol: expect.any(Number),
      server: {
        version: expect.any(String),
        connId: expect.any(String),
      },
      features: {
        methods: expect.arrayContaining(["health", "agent"]),
        events: expect.arrayContaining(["connect.challenge", "heartbeat"]),
      },
    },
  });
  return ws;
}

test("publishes canonical envelopes, discovery catalogs, and ordered events", async () => {
  const clients = await Promise.all([openWireClient(), openWireClient()]);

  try {
    const healthResponsePromise = onceMessage<WireFrame>(
      clients[0],
      (frame) => frame.type === "res" && frame.id === "wire-health",
    );
    clients[0].send(JSON.stringify({ type: "req", id: "wire-health", method: "health" }));
    expect(await healthResponsePromise).toMatchObject({
      type: "res",
      id: "wire-health",
      ok: true,
      payload: expect.any(Object),
    });

    const sequences = clients.map(() => Number.NEGATIVE_INFINITY);
    const events: Parameters<typeof emitHeartbeatEvent>[0][] = [
      { status: "sent", to: "qa-wire", preview: "first" },
      { status: "skipped", reason: "qa-wire-ordering" },
    ];
    for (const event of events) {
      const received = clients.map((ws) =>
        onceMessage<WireFrame>(
          ws,
          (frame) =>
            frame.type === "event" &&
            frame.event === "heartbeat" &&
            frame.payload?.status === event.status,
        ),
      );
      emitHeartbeatEvent(event);
      for (const [index, frame] of (await Promise.all(received)).entries()) {
        expect(frame).toMatchObject({
          type: "event",
          event: "heartbeat",
          payload: { status: event.status },
          seq: expect.any(Number),
        });
        expect(frame.seq).toBeGreaterThan(sequences[index] ?? Number.NEGATIVE_INFINITY);
        sequences[index] = frame.seq!;
      }
    }
  } finally {
    for (const client of clients) {
      client.close();
    }
  }
});
