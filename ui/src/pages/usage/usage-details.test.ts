/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createUsageDetailFixture } from "./usage-details.test-support.ts";
import { cleanupUsagePageTest, contextWithClient } from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);
describe("Usage detail requests", () => {
  it.each(["resolve", "reject"])(
    "commits only the latest time-series selection (%s)",
    async (completion) => {
      const first = deferred<SessionUsageTimeSeries>();
      const second = deferred<SessionUsageTimeSeries>();
      const request = vi.fn((_method: string, params: { key: string }) =>
        params.key === "agent:main:a" ? first.promise : second.promise,
      );
      const { details } = createUsageDetailFixture({ request } as unknown as GatewayBrowserClient);

      const firstLoad = details.timeSeries.load("agent:main:a");
      await waitForFast(() => expect(request).toHaveBeenCalledOnce());

      const secondLoad = details.timeSeries.load("agent:main:b");
      const latest = { points: [{ timestamp: 2 }] } as SessionUsageTimeSeries;
      second.resolve(latest);
      await secondLoad;
      if (completion === "resolve") {
        first.resolve({ points: [{ timestamp: 1 }] } as SessionUsageTimeSeries);
      } else {
        first.reject(new Error("superseded timeline failed"));
      }
      await firstLoad;

      expect(details.timeSeries.data).toBe(latest);
      expect(details.timeSeries.status.error).toBeNull();
    },
  );

  it("retains stale time-series data until a retry succeeds", async () => {
    const retry = deferred<SessionUsageTimeSeries>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockReturnValueOnce(retry.promise);
    const { details } = createUsageDetailFixture({ request } as unknown as GatewayBrowserClient);

    await details.timeSeries.load("agent:main:detail");
    const previous = details.timeSeries.data;

    await details.timeSeries.load("agent:main:detail");
    expect(details.timeSeries.status).toEqual({
      error: "timeline unavailable",
      hasLoaded: true,
      stale: true,
      awaitingGateway: false,
    });
    expect(details.timeSeries.data).toBe(previous);

    const retryLoad = details.timeSeries.load("agent:main:detail");
    expect(details.timeSeries.status).toEqual({
      error: null,
      hasLoaded: true,
      stale: true,
      awaitingGateway: false,
    });
    const result = { points: [] } as unknown as SessionUsageTimeSeries;
    retry.resolve(result);
    await retryLoad;

    expect(details.timeSeries.data).toBe(result);
    expect(details.timeSeries.status).toEqual({
      error: null,
      hasLoaded: true,
      stale: false,
      awaitingGateway: false,
    });
  });

  it("does not retain detail data when the selected session changes", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
      .mockResolvedValueOnce({
        logs: [{ timestamp: 1, role: "user", content: "session A" }],
      })
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockRejectedValueOnce(new Error("logs unavailable"));
    const { details } = createUsageDetailFixture({ request } as unknown as GatewayBrowserClient);

    await details.timeSeries.load("agent:main:a");
    await details.sessionLogs.load("agent:main:a");

    await details.timeSeries.load("agent:main:b");
    await details.sessionLogs.load("agent:main:b");

    expect(details.timeSeries.data).toBeNull();
    expect(details.timeSeries.status).toEqual({
      error: "timeline unavailable",
      hasLoaded: false,
      stale: false,
      awaitingGateway: false,
    });
    expect(details.sessionLogs.data).toBeNull();
    expect(details.sessionLogs.status).toEqual({
      error: "logs unavailable",
      hasLoaded: false,
      stale: false,
      awaitingGateway: false,
    });
  });

  it.each(["draining"] as const)(
    "clears retained details and preserves read authorization errors while %s",
    async (suspensionPhase) => {
      const pending = deferred<never>();
      const authorizationError = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.read",
      });
      const request = vi
        .fn()
        .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
        .mockResolvedValueOnce({
          logs: [{ timestamp: 1, role: "user", content: "sensitive" }],
        })
        .mockReturnValue(pending.promise);
      const client = { request } as unknown as GatewayBrowserClient;
      const context = contextWithClient(client);
      const { details } = createUsageDetailFixture(client, context);

      await details.timeSeries.load("agent:main:detail");
      await details.sessionLogs.load("agent:main:detail");
      const timeline = details.timeSeries.load("agent:main:detail");
      const conversation = details.sessionLogs.load("agent:main:detail");
      context.setGatewaySnapshot({ suspensionPhase });
      pending.reject(authorizationError);
      await Promise.all([timeline, conversation]);

      expect(details.timeSeries.data).toBeNull();
      expect(details.timeSeries.status).toEqual({
        error:
          "You don't have permission to view usage details. Ask the person who manages OpenClaw for access.",
        hasLoaded: false,
        stale: false,
        awaitingGateway: false,
      });
      expect(details.sessionLogs.data).toBeNull();
      expect(details.sessionLogs.status).toEqual({
        error:
          "You don't have permission to view usage details. Ask the person who manages OpenClaw for access.",
        hasLoaded: false,
        stale: false,
        awaitingGateway: false,
      });
    },
  );
});
