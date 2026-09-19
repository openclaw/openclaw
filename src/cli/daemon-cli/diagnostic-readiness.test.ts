import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  callGateway,
  inspectPortUsage,
  monotonicClock,
  readGatewayOwnerLease,
  requestStartupProbe,
  resetRestartHealthMocks,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const { readRuntime, readCommand } = vi.hoisted(() => ({
  readCommand: vi.fn(async () => ({ programArguments: ["gateway", "--port", "18789"] })),
  readRuntime: vi.fn(async () => ({ status: "stopped" })),
}));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readRuntime, readCommand }),
}));
const { waitForGatewayDiagnosticReadiness } = await import("./diagnostic-readiness.js");

describe("diagnostic Gateway readiness", () => {
  beforeEach(() => {
    resetRestartHealthMocks();
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: "free",
      listeners: [],
      hints: [],
    }));
    readRuntime.mockReset();
    readRuntime.mockResolvedValue({ status: "stopped" });
    readCommand.mockReset();
    readCommand.mockResolvedValue({ programArguments: ["gateway", "--port", "18789"] });
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
  });
  afterEach(() => {
    restoreRestartHealthMocks();
    vi.unstubAllEnvs();
  });

  it.each<{ envUrl?: string; url?: string; config?: OpenClawConfig }>([
    { url: "ws://127.0.0.1:18789" },
    { config: { gateway: { mode: "remote", remote: { url: "wss://peer.example" } } } },
    { envUrl: "wss://peer.example" },
  ])("preserves an explicit or remote target: %j", async ({ envUrl, ...options }) => {
    if (envUrl) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", envUrl);
    }
    await expect(
      waitForGatewayDiagnosticReadiness({ config: {}, ...options }),
    ).resolves.toBeUndefined();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("defers to original diagnostic authentication when no shared credential is available", async () => {
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "token" } } },
    });
    expect(result).toBeUndefined();
    expect(monotonicClock.nowMs).toBe(0);
    expect(readRuntime).not.toHaveBeenCalled();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([20_000, 7_500])(
    "observes a foreground startup using the selected config, auth, port and %d ms budget",
    async (timeoutMs) => {
      const config: OpenClawConfig = { gateway: { port: 19091, auth: { mode: "token" } } };
      resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({
        auth: { token: "fixture-token" },
      });
      readGatewayOwnerLease.mockReturnValue({
        owner: "fixture-owner",
        pid: 8000,
        host: "fixture-host",
        startedAt: 1,
        port: 19091,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      }));
      requestStartupProbe.mockImplementation(async () => ({
        statusCode: monotonicClock.nowMs < 20_000 ? 503 : 200,
        body: JSON.stringify(
          monotonicClock.nowMs < 20_000
            ? { status: "starting", pendingReason: "plugin-convergence" }
            : { status: "started" },
        ),
      }));
      callGateway.mockImplementation(gatewayHealthResponse());
      const result = await waitForGatewayDiagnosticReadiness({
        config,
        token: "fixture-token",
        timeoutMs,
      });
      expect(result).toMatchObject({
        healthy: timeoutMs === 20_000,
        waitOutcome: timeoutMs === 20_000 ? "healthy" : "still-starting",
        elapsedMs: timeoutMs,
        runtime: { status: "running", pid: 8000 },
        portUsage: { port: 19091 },
      });
      expect(readRuntime).not.toHaveBeenCalled();
      if (timeoutMs === 20_000) {
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({ config, token: "fixture-token", localPortOverride: 19091 }),
        );
      } else {
        expect(result?.startupPhase).toBe("plugin-convergence");
        expect(callGateway).not.toHaveBeenCalled();
      }
    },
  );

  it("does not use a different installed service as the selected Gateway's process identity", async () => {
    readRuntime.mockResolvedValueOnce({ status: "running" });
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      localPortOverride: 19092,
      timeoutMs: 1_000,
    });
    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: "timeout",
      elapsedMs: 1_000,
      runtime: { status: "unknown" },
      portUsage: { port: 19092 },
    });
    expect(readRuntime).not.toHaveBeenCalled();
  });

  it("bounds an actually-down Gateway with the caller's shorter deadline", async () => {
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_250,
    });
    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: "timeout",
      elapsedMs: 1_250,
      portUsage: { status: "free" },
    });
    expect(callGateway).not.toHaveBeenCalled();
  });
});
