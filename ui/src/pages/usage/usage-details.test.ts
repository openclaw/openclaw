/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionUsageTimeSeries } from "../../../../src/shared/session-usage-timeseries-types.js";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway-connect-errors.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createUsageDetailFixture } from "./usage-details.test-support.ts";
import { cleanupUsagePageTest, contextWithClient } from "./usage-page.test-support.ts";

afterEach(cleanupUsagePageTest);
const request = vi.fn();
let context: ReturnType<typeof contextWithClient>;
let details: ReturnType<typeof createUsageDetailFixture>["details"];
beforeEach(() => {
  request.mockReset();
  const client = { request } as unknown as GatewayBrowserClient;
  context = contextWithClient(client);
  ({ details } = createUsageDetailFixture(client, context));
});
const status = (error: string | null, hasLoaded = true, stale = false) => ({
  error,
  hasLoaded,
  stale,
  awaitingGateway: false,
});
async function loadedDetails() {
  request
    .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
    .mockResolvedValueOnce({ logs: [{ timestamp: 1, role: "user", content: "sensitive" }] });
  await details.timeSeries.load("agent:main:detail");
  await details.sessionLogs.load("agent:main:detail");
}
it.each(["resolve", "reject"])(
  "commits only the latest time-series selection (%s)",
  async (completion) => {
    const first = deferred<SessionUsageTimeSeries>();
    const second = deferred<SessionUsageTimeSeries>();
    request.mockImplementation((_method: string, params: { key: string }) =>
      params.key === "agent:main:a" ? first.promise : second.promise,
    );

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
  request
    .mockResolvedValueOnce({ points: [{ timestamp: 1 }] })
    .mockRejectedValueOnce(new Error("timeline unavailable"))
    .mockReturnValueOnce(retry.promise);

  await details.timeSeries.load("agent:main:detail");
  const previous = details.timeSeries.data;

  await details.timeSeries.load("agent:main:detail");
  expect(details.timeSeries.status).toEqual(status("timeline unavailable", true, true));
  expect(details.timeSeries.data).toBe(previous);

  const retryLoad = details.timeSeries.load("agent:main:detail");
  expect(details.timeSeries.status).toEqual(status(null, true, true));
  const result = { points: [] } as unknown as SessionUsageTimeSeries;
  retry.resolve(result);
  await retryLoad;

  expect(details.timeSeries.data).toBe(result);
  expect(details.timeSeries.status).toEqual(status(null));
});

it("does not retain detail data when the selected session changes", async () => {
  await loadedDetails();
  request
    .mockRejectedValueOnce(new Error("timeline unavailable"))
    .mockRejectedValueOnce(new Error("logs unavailable"));

  await details.timeSeries.load("agent:main:b");
  await details.sessionLogs.load("agent:main:b");

  for (const [detail, error] of [
    [details.timeSeries, "timeline unavailable"],
    [details.sessionLogs, "logs unavailable"],
  ] as const) {
    expect(detail.data).toBeNull();
    expect(detail.status).toEqual(status(error, false));
  }
});

it("clears retained details and preserves read authorization errors while draining", async () => {
  const pending = deferred<never>();
  const authorizationError = new GatewayRequestError({
    code: "INVALID_REQUEST",
    message: "missing scope: operator.read",
  });
  await loadedDetails();
  request.mockReturnValue(pending.promise);
  const timeline = details.timeSeries.load("agent:main:detail");
  const conversation = details.sessionLogs.load("agent:main:detail");
  context.setGatewaySnapshot({ suspensionPhase: "draining" });
  pending.reject(authorizationError);
  await Promise.all([timeline, conversation]);

  const error =
    "You don't have permission to view usage details. Ask the person who manages OpenClaw for access.";
  for (const detail of [details.timeSeries, details.sessionLogs]) {
    expect(detail.data).toBeNull();
    expect(detail.status).toEqual(status(error, false));
  }
});
