import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMissionControlOverview } from "./mission-control-api.js";

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
