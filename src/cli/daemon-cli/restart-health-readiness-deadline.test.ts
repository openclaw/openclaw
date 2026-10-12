import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import { waitForGatewayHttpReadiness } from "./restart-health-probe.js";

const transport = vi.hoisted(() => ({
  requestHttp: vi.fn<ConfiguredGatewayLocalProbe["requestHttp"]>(),
  sleep: vi.fn(async () => {}),
}));

// This deadline owner needs HTTP observations, not a real client graph or server.
vi.mock("../../gateway/call.js", () => ({ callGateway: vi.fn() }));
vi.mock("../../gateway/local-http-probe.js", () => ({
  createConfiguredGatewayLocalProbe: () => ({ requestHttp: transport.requestHttp }),
}));
vi.mock("../../utils.js", () => ({ sleep: transport.sleep }));

let monotonicNow: number;
let wallNow: number;
beforeEach(() => {
  vi.clearAllMocks();
  monotonicNow = 10_000;
  wallNow = monotonicNow;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
});
afterEach(() => vi.restoreAllMocks());

it.each([0, -300_000, 300_000])(
  "holds the readiness budget when wall time changes by %sms",
  async (wallAdjustmentMs) => {
    // Both domains start aligned: the old implementation receives a valid
    // deadline too. Only a mid-probe wall-clock change distinguishes them.
    transport.requestHttp.mockImplementation(async () => {
      monotonicNow += 20;
      wallNow = monotonicNow + wallAdjustmentMs;
      return null;
    });
    await expect(
      waitForGatewayHttpReadiness({
        attempts: 100,
        deadlineAt: performance.now() + 50,
        delayMs: 0,
        port: 18_789,
      }),
    ).resolves.toEqual({ healthz: null, readyz: null });
    expect(monotonicNow).toBe(10_080);
    expect(transport.requestHttp).toHaveBeenCalledTimes(4);
    expect(transport.requestHttp.mock.calls[2]?.[0].timeoutMs).toBe(10);
  },
);

it("does not start HTTP work after the allowance expired", async () => {
  await expect(
    waitForGatewayHttpReadiness({
      attempts: 100,
      deadlineAt: performance.now(),
      delayMs: 0,
      port: 18_789,
    }),
  ).resolves.toEqual({ healthz: null, readyz: null });
  expect(transport.requestHttp).not.toHaveBeenCalled();
});

it("does not start HTTP work after cancellation", async () => {
  const cause = new Error("cancelled readiness");
  await expect(
    waitForGatewayHttpReadiness({
      attempts: 100,
      deadlineAt: performance.now() + 50,
      delayMs: 0,
      port: 18_789,
      signal: AbortSignal.abort(cause),
    }),
  ).rejects.toBe(cause);
  expect(transport.requestHttp).not.toHaveBeenCalled();
});
