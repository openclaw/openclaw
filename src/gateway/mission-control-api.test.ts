import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMissionControlOverview, getMissionControlRuns } from "./mission-control-api.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("./call.js", () => ({
  callGateway: callGatewayMock,
}));

describe("getMissionControlOverview", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "sessions.list") {
        return { sessions: [] };
      }
      if (request.method === "sessions.usage") {
        return {
          sessions: [],
          aggregates: {
            messages: {
              total: 0,
              toolCalls: 0,
              errors: 0,
            },
          },
          totals: {
            totalCost: 0,
          },
        };
      }
      throw new Error(`Unexpected callGateway method: ${request.method}`);
    });
  });

  it("keeps liveness green while surfacing /readyz degradation", async () => {
    const snapshot = await getMissionControlOverview({
      getReadiness: () => ({
        ready: false,
        failing: ["discord"],
        uptimeMs: 12_000,
      }),
    });

    expect(snapshot.health.live).toBe(true);
    expect(snapshot.health.ready).toBe(false);
    expect(snapshot.health.probes.healthz).toEqual({
      path: "/healthz",
      ok: true,
      statusCode: 200,
    });
    expect(snapshot.health.probes.readyz).toEqual({
      path: "/readyz",
      ok: false,
      statusCode: 503,
      failing: ["discord"],
      uptimeMs: 12_000,
    });
  });

  it("returns an internal readiness failure when checker throws", async () => {
    const snapshot = await getMissionControlOverview({
      getReadiness: () => {
        throw new Error("boom");
      },
    });

    expect(snapshot.health.ready).toBe(false);
    expect(snapshot.health.probes.readyz).toMatchObject({
      path: "/readyz",
      ok: false,
      statusCode: 503,
      failing: ["internal"],
      uptimeMs: 0,
    });
  });
});

describe("getMissionControlRuns", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("merges usage cost and model data into run history", async () => {
    callGatewayMock.mockImplementation(async (request: { method: string }) => {
      if (request.method === "sessions.list") {
        return {
          sessions: [
            {
              key: "agent:angela:s-1",
              label: "Angela campaign run",
              agentId: "angela",
              channel: "operator-control",
              updatedAt: Date.now() - 60_000,
              totalTokens: 120,
            },
          ],
        };
      }

      if (request.method === "sessions.usage") {
        return {
          sessions: [
            {
              key: "agent:angela:s-1",
              agentId: "angela",
              modelProvider: "anthropic",
              model: "claude-opus-4-6",
              usage: {
                totalTokens: 4321,
                totalCost: 1.23,
              },
            },
          ],
          aggregates: {
            messages: {
              total: 0,
              toolCalls: 0,
              errors: 0,
            },
          },
          totals: {
            totalCost: 1.23,
          },
        };
      }

      throw new Error(`Unexpected callGateway method: ${request.method}`);
    });

    const snapshot = await getMissionControlRuns({
      search: "",
      activeMinutes: 60,
      limit: 10,
    });

    expect(snapshot.history[0]).toMatchObject({
      key: "agent:angela:s-1",
      agentId: "angela",
      totalTokens: 4321,
      totalCostUsd: 1.23,
      model: "anthropic/claude-opus-4-6",
    });
  });
});
