import { describe, expect, it, vi } from "vitest";
import { AUTH_NONE, createTestGatewayServer, sendRequest } from "./server-http.test-harness.js";

describe("oc heartbeat agents http", () => {
  it("returns the heartbeat runner snapshot batch", async () => {
    const getAgentSnapshots = vi.fn(() => [
      { agentId: "zeta", lastRunStartedAtMs: undefined },
      { agentId: "alpha", lastRunStartedAtMs: 1_700_000_000_000 },
    ]);
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        getHeartbeatRunner: () => ({
          stop: () => {},
          updateConfig: () => {},
          getAgentSnapshots,
        }),
      },
    });

    const response = await sendRequest(server, {
      path: "/oc/heartbeat/agents",
      method: "GET",
      remoteAddress: "127.0.0.1",
    });

    expect(response.res.statusCode).toBe(200);
    expect(JSON.parse(response.getBody())).toEqual({
      agents: [
        { agentId: "alpha", lastSeenAt: "2023-11-14T22:13:20.000Z" },
        { agentId: "zeta", lastSeenAt: null },
      ],
    });
    expect(getAgentSnapshots).toHaveBeenCalledTimes(1);
  });

  it("requires GET", async () => {
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        getHeartbeatRunner: () => ({
          stop: () => {},
          updateConfig: () => {},
          getAgentSnapshots: () => [],
        }),
      },
    });

    const response = await sendRequest(server, {
      path: "/oc/heartbeat/agents",
      method: "POST",
      remoteAddress: "127.0.0.1",
    });

    expect(response.res.statusCode).toBe(405);
  });

  it("rejects remote unauthenticated callers when gateway auth is none", async () => {
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_NONE,
      overrides: {
        getHeartbeatRunner: () => ({
          stop: () => {},
          updateConfig: () => {},
          getAgentSnapshots: () => [],
        }),
      },
    });

    const response = await sendRequest(server, {
      path: "/oc/heartbeat/agents",
      method: "GET",
      remoteAddress: "203.0.113.10",
    });

    expect(response.res.statusCode).toBe(401);
  });
});
