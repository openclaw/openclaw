import { createServer as createHttpServer } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import type { TestPortClaim } from "../test-utils/port-claims.js";
import { gatewayFixtureLifetime } from "./gateway-fixture-lifetime.test-support.js";
import { startGatewayServerHarness } from "./server.e2e-ws-harness.js";
import type { GatewayServer } from "./server.js";

const startup = vi.hoisted(() => ({
  reservation: vi.fn<typeof import("./test-helpers.listener.js").reserveGatewayTestListener>(),
  server: vi.fn<(claim: TestPortClaim) => Promise<GatewayServer>>(),
}));
vi.mock("./test-helpers.listener.js", () => ({
  reserveGatewayTestListener: startup.reservation,
}));
vi.mock("./test-helpers.js", () => ({
  startTestGatewayServer: startup.server,
  connectOk: vi.fn(),
  trackConnectChallengeNonce: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

test.each(["port", "admission", "server"] as const)(
  "restores its token snapshot when %s acquisition fails before publishing a close handle",
  async (stage) => {
    const env = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
    const failure = new Error(`injected ${stage} acquisition failure`);
    process.env.OPENCLAW_GATEWAY_TOKEN = "fixture-token";
    const release = vi.fn(async () => {});
    let released = false;
    const closeUnadopted = async () => {
      if (!released) {
        released = true;
        await release();
      }
    };
    startup.reservation.mockResolvedValue({
      port: 12345,
      listener: createHttpServer(),
      closeUnadopted,
      start: async (run) => run(),
    });
    startup.server.mockImplementation(async (claim) => {
      await claim.release();
      throw failure;
    });
    if (stage === "port") {
      startup.reservation.mockRejectedValue(failure);
    }
    if (stage === "admission") {
      vi.spyOn(gatewayFixtureLifetime, "assertAdmission")
        .mockImplementationOnce(() => {})
        .mockImplementationOnce(() => {
          throw failure;
        });
    }
    try {
      await expect(startGatewayServerHarness()).rejects.toBe(failure);
      expect(process.env.OPENCLAW_GATEWAY_TOKEN).toBe("fixture-token");
      expect(release).toHaveBeenCalledTimes(stage === "port" ? 0 : 1);
      expect(startup.server).toHaveBeenCalledTimes(stage === "server" ? 1 : 0);
    } finally {
      env.restore();
    }
  },
);
