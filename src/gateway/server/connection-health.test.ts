import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { HealthSummary } from "../../commands/health.js";
import {
  CONNECTION_STALE_MS,
  recordConnectionPong,
  withConnectionHealth,
} from "./connection-health.js";
import type { GatewayWsClient } from "./ws-types.js";

function createHealthSummary(): HealthSummary {
  return {
    ok: true,
    ts: 100,
    durationMs: 1,
    channels: {},
    channelOrder: [],
    channelLabels: {},
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: {
      path: "/tmp/sessions.json",
      count: 0,
      recent: [],
    },
  };
}

function createClient(params: {
  readyState?: number;
  connectedAtMs?: number;
  lastPingSentAtMs?: number;
  pendingPingSentAtMs?: number[];
  lastHeartbeatAtMs?: number;
  rttMs?: number;
}): GatewayWsClient {
  return {
    socket: { readyState: params.readyState ?? WebSocket.OPEN } as never,
    connect: { role: "operator", client: { id: "test", version: "1", mode: "cli" } } as never,
    connId: "conn-1",
    connectionHealth: {
      connectedAtMs: params.connectedAtMs ?? 1,
      ...(params.lastPingSentAtMs !== undefined
        ? { lastPingSentAtMs: params.lastPingSentAtMs }
        : {}),
      ...(params.pendingPingSentAtMs !== undefined
        ? { pendingPingSentAtMs: params.pendingPingSentAtMs }
        : {}),
      ...(params.lastHeartbeatAtMs !== undefined
        ? { lastHeartbeatAtMs: params.lastHeartbeatAtMs }
        : {}),
      ...(params.rttMs !== undefined ? { rttMs: params.rttMs } : {}),
    },
    usesSharedGatewayAuth: false,
  };
}

describe("connection health", () => {
  it("adds a connection overlay without mutating the cached health summary", () => {
    const cached = createHealthSummary();
    const client = createClient({});

    const summary = withConnectionHealth(cached, client, 1_000);

    expect(cached.connection).toBeUndefined();
    expect(summary).not.toBe(cached);
    expect(summary.connection).toEqual({
      connected: true,
      rttMs: null,
      lastHeartbeatAt: null,
    });
  });

  it("reports sockets with no first pong as disconnected after the stale window", () => {
    const summary = withConnectionHealth(
      createHealthSummary(),
      createClient({ connectedAtMs: 1_000 }),
      1_000 + CONNECTION_STALE_MS + 1,
    );

    expect(summary.connection).toEqual({
      connected: false,
      rttMs: null,
      lastHeartbeatAt: null,
    });
  });

  it("reports stale open sockets as disconnected while preserving historical RTT", () => {
    const summary = withConnectionHealth(
      createHealthSummary(),
      createClient({
        lastHeartbeatAtMs: 1_000,
        rttMs: 42,
      }),
      1_000 + CONNECTION_STALE_MS + 1,
    );

    expect(summary.connection).toEqual({
      connected: false,
      rttMs: 42,
      lastHeartbeatAt: 1_000,
    });
  });

  it("reports closed sockets as disconnected while preserving historical RTT", () => {
    const summary = withConnectionHealth(
      createHealthSummary(),
      createClient({
        readyState: WebSocket.CLOSED,
        lastHeartbeatAtMs: 1_000,
        rttMs: 42,
      }),
      2_000,
    );

    expect(summary.connection).toEqual({
      connected: false,
      rttMs: 42,
      lastHeartbeatAt: 1_000,
    });
  });

  it("records pong RTT with EWMA smoothing", () => {
    const client = createClient({ lastPingSentAtMs: 1_000, rttMs: 50 });

    expect(recordConnectionPong(client, Buffer.from("1000"), 1_100)).toBe(true);

    expect(client.connectionHealth).toMatchObject({
      rttMs: 60,
      lastHeartbeatAtMs: 1_100,
    });
  });

  it("accepts delayed pong samples within the stale window", () => {
    const client = createClient({
      lastPingSentAtMs: 5_000,
      pendingPingSentAtMs: [0, 5_000],
    });

    expect(recordConnectionPong(client, Buffer.from("0"), 6_000)).toBe(true);

    expect(client.connectionHealth).toMatchObject({
      lastHeartbeatAtMs: 6_000,
      rttMs: 6_000,
      pendingPingSentAtMs: [5_000],
    });
  });

  it("rejects delayed pong samples outside the stale window", () => {
    const client = createClient({
      lastPingSentAtMs: 10_000,
      pendingPingSentAtMs: [0, 10_000],
    });

    expect(recordConnectionPong(client, Buffer.from("0"), CONNECTION_STALE_MS + 1)).toBe(false);

    expect(client.connectionHealth.lastHeartbeatAtMs).toBeUndefined();
    expect(client.connectionHealth.rttMs).toBeUndefined();
    expect(client.connectionHealth.pendingPingSentAtMs).toEqual([0, 10_000]);
  });

  it("ignores pongs that do not echo the latest numeric ping payload", () => {
    const client = createClient({ lastPingSentAtMs: 1_000 });

    expect(recordConnectionPong(client, Buffer.from("999"), 1_100)).toBe(false);
    expect(recordConnectionPong(client, Buffer.from("not-a-number"), 1_100)).toBe(false);

    expect(client.connectionHealth.lastHeartbeatAtMs).toBeUndefined();
    expect(client.connectionHealth.rttMs).toBeUndefined();
  });

  it("keeps connection overlays isolated per client", () => {
    const cached = createHealthSummary();
    const fast = createClient({ lastHeartbeatAtMs: 1_000, rttMs: 10 });
    const slow = createClient({ lastHeartbeatAtMs: 1_100, rttMs: 200 });

    expect(withConnectionHealth(cached, fast, 1_200).connection).toEqual({
      connected: true,
      rttMs: 10,
      lastHeartbeatAt: 1_000,
    });
    expect(withConnectionHealth(cached, slow, 1_200).connection).toEqual({
      connected: true,
      rttMs: 200,
      lastHeartbeatAt: 1_100,
    });
    expect(cached.connection).toBeUndefined();
  });
});
