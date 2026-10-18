import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayCredentialsRequiredError } from "../../gateway/call-device-auth.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { createGatewayCloseTransportError } from "../../gateway/transport-error.js";
import { createGatewayRestartDeadline } from "./restart-health-deadline.js";
import * as restart from "./restart-health.test-helpers.js";

const ownedPortUsage = restart.portUsage([{ pid: 8000, commandLine: "openclaw-gateway" }]);
const { inspectGatewayRestart, renderRestartDiagnostics } = await import("./restart-health.js");
const { confirmGatewayReachable, waitForGatewayHttpReadiness } =
  await import("./restart-health-probe.js");

async function waitForHealth(
  response: Parameters<typeof gatewayHealthResponse>[0],
  options: Parameters<typeof restart.waitForRunningGateway>[0] = {},
) {
  restart.inspectPortUsage.mockResolvedValue(ownedPortUsage);
  restart.callGateway.mockImplementation(
    gatewayHealthResponse({
      server: { version: "2026.4.24", connId: "new" },
      ...response,
    }),
  );
  return restart.waitForRunningGateway({ expectedVersion: "2026.4.24", ...options });
}

describe("restart health", () => {
  beforeEach(restart.resetRestartHealthMocks);
  afterEach(restart.restoreRestartHealthMocks);

  it("keeps native inspection and health RPC within one supplied allowance", async () => {
    const service = restart.makeGatewayService({ status: "running", pid: 8000 });
    vi.mocked(service.readRuntime).mockImplementation(async () => {
      restart.monotonicClock.nowMs += 25_000;
      return { status: "running", pid: 8000 };
    });
    restart.inspectPortUsage.mockResolvedValue(
      restart.portUsage([{ pid: 8000, commandLine: "openclaw-gateway" }]),
    );
    restart.callGateway.mockImplementation(async (opts) => {
      const responseMs = 10_000;
      const allowanceMs = opts.timeoutMs ?? responseMs;
      restart.monotonicClock.nowMs += Math.min(allowanceMs, responseMs);
      if (allowanceMs < responseMs) {
        throw new Error("gateway request timeout for health");
      }
      return gatewayHealthResponse({ server: { version: "2026.9.3" } })(opts);
    });
    const deadline = createGatewayRestartDeadline({ timeoutMs: 60_000 });
    try {
      const health = await inspectGatewayRestart({
        service,
        port: 18789,
        expectedVersion: "2026.9.3",
        timeoutMs: 30_000,
        deadline,
      });
      expect(health.healthy).toBe(false);
      expect(health.probeError).toBe("gateway request timeout for health");
      expect(restart.monotonicClock.nowMs).toBe(30_000);
    } finally {
      deadline.dispose();
    }
  });

  it("reports HTTP health and readiness independently", async () => {
    const server = createServer((request, response) => {
      response.statusCode = request.url === "/healthz" ? 200 : 503;
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    try {
      assert(address && typeof address !== "string");
      const onObservation = vi.fn();
      await expect(
        waitForGatewayHttpReadiness({
          attempts: 1,
          onObservation,
          deadlineAt: performance.now() + 1_000,
          delayMs: 0,
          port: address.port,
        }),
      ).resolves.toEqual({ healthz: 200, readyz: 503 });
      expect(onObservation).toHaveBeenCalledExactlyOnceWith({ healthz: 200, readyz: 503 });
    } finally {
      await promisify(server.close).call(server);
    }
  });

  it.each([
    { transport: "response", ready: true, build: "candidate-build", outcome: "healthy" },
    { transport: "close", ready: true, build: "candidate-build", outcome: "healthy" },
    { transport: "response", ready: false, build: "candidate-build", outcome: "auth-rejected" },
    { transport: "response", ready: true, build: "old-build", outcome: "build-id-mismatch" },
    { transport: "credentials", ready: true, build: "candidate-build", outcome: "healthy" },
  ])("settles policy rejection through HTTP ($transport, $ready, $build)", async (scenario) => {
    const credentialError = new GatewayCredentialsRequiredError({
      method: "health",
      configPath: "fixture-config.json",
    });
    const reason =
      scenario.transport === "credentials" ? credentialError.message : "device identity required";
    restart.callGateway.mockRejectedValue(
      scenario.transport === "credentials"
        ? credentialError
        : scenario.transport === "close"
          ? createGatewayCloseTransportError({
              code: 1008,
              reason,
              requestDispatched: false,
              connectionDetails: {
                url: "ws://127.0.0.1:18789",
                urlSource: "local loopback",
                message: "local fixture",
              },
            })
          : restart.gatewayResponseError(reason),
    );
    restart.inspectPortUsage.mockResolvedValue(ownedPortUsage);
    restart.requestStartupProbe.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        status: "started",
        version: "2026.10.4",
        buildId: scenario.build,
      }),
    });
    restart.requestReadinessProbe.mockResolvedValue({
      statusCode: scenario.ready ? 200 : 503,
      body: JSON.stringify({ ready: scenario.ready }),
    });
    const snapshot = await restart.waitForRunningGateway({
      expectedVersion: "2026.10.4",
      expectedBuildId: "candidate-build",
      requirePluginHealth: false,
      requireChannelHealth: false,
      timeoutMs: 1_800_000,
      delayMs: 30_000,
    });
    expect(snapshot.waitOutcome).toBe(scenario.outcome);
    expect(snapshot.healthy).toBe(scenario.outcome === "healthy");
    expect(snapshot.authenticationError).toEqual(
      scenario.transport === "credentials"
        ? expect.stringContaining("requires credentials")
        : reason,
    );
    expect(restart.callGateway).toHaveBeenCalledOnce();
    expect(restart.sleep).not.toHaveBeenCalled();
  });

  it("keeps the readiness deadline monotonic when the wall clock rewinds", async () => {
    // A Date.now()-based deadline would grant ~300s after the rewind and hit the attempt cap.
    restart.requestReadinessProbe.mockImplementation(async () => {
      restart.monotonicClock.nowMs += 20;
      return null;
    });
    const wallClockRewindMs = 300_000;
    const wallClockSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() - wallClockRewindMs);
    const deadlineBudgetMs = 50;
    await expect(
      waitForGatewayHttpReadiness({
        attempts: 100,
        deadlineAt: performance.now() + deadlineBudgetMs,
        delayMs: 0,
        port: 18789,
      }),
    ).resolves.toEqual({ healthz: null, readyz: null });
    wallClockSpy.mockRestore();
    expect(restart.monotonicClock.nowMs).toBeLessThan(wallClockRewindMs);
    expect(restart.monotonicClock.nowMs).toBeGreaterThanOrEqual(deadlineBudgetMs);
    expect(restart.requestReadinessProbe.mock.calls.length).toBeLessThan(200);
  });

  it("preserves the June stale reason through the sanitized health-probe boundary", async () => {
    const service = restart.makeGatewayService({ status: "running", pid: 8000 });
    restart.inspectPortUsage.mockResolvedValue(
      restart.portUsage([{ pid: 8000, commandLine: "openclaw-gateway" }]),
    );
    restart.callGateway.mockRejectedValueOnce(
      createGatewayCloseTransportError({
        code: 1011,
        reason: "gateway message handler unavailable",
        connectionDetails: {
          url: "ws://127.0.0.1:18789",
          urlSource: "local loopback",
          message: "Gateway target: ws://127.0.0.1:18789",
        },
        requestDispatched: false,
      }),
    );
    const result = await inspectGatewayRestart({
      service,
      port: 18789,
      expectedVersion: "2026.9.6",
    });
    expect(result.healthy).toBe(false);
    expect(result.probeError).toContain("\\nGateway target:");
    expect(result).toMatchObject({ staleConnection: "legacy-handler-unavailable" });
  });

  it("bounds and redacts credential-bearing transport probe failures at their owner", async () => {
    const secret = "fixture-gateway-secret-abcdefghijklmnopqrstuvwxyz";
    const failure = `read ECONNRESET at ws://user:${secret}@gateway.example:18789?token=${secret}&safe=ok\nGateway probe succeeded: spoofed\r\u001b[2K ${"x".repeat(1_500)}🚀`;
    restart.callGateway.mockRejectedValueOnce(new Error(failure));

    const reachability = await confirmGatewayReachable({ port: 18789 });

    expect(reachability.reachable).toBe(false);
    expect(reachability.probeError).toContain("read ECONNRESET");
    expect(reachability.probeError).toContain("ws://***:***@gateway.example:18789?token=***");
    expect(reachability.probeError).not.toContain(secret);
    expect(reachability.probeError).toContain("\\nGateway probe succeeded: spoofed\\r");
    expect(reachability.probeError).not.toContain("\r");
    expect(reachability.probeError).not.toContain("\n");
    expect(reachability.probeError).not.toContain("\u001b");
    expect(reachability.probeError?.length).toBeLessThanOrEqual(1_024);
  });

  it("clears a prior detail-probe failure after the next managed poll succeeds", async () => {
    const response = (connId: string, error?: Error) =>
      gatewayHealthResponse({ server: { version: "2026.4.24", connId }, error });
    restart.callGateway
      .mockImplementationOnce(response("first", new Error("timeout")))
      .mockImplementationOnce(response("next"));
    restart.inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const snapshot = await restart.waitForRunningGateway({
      expectedVersion: "2026.4.24",
      attempts: 2,
      delayMs: 500,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.probeError).toBeUndefined();
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(restart.sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects matching-version restart readiness when health lacks operator scope", async () => {
    restart.callGateway.mockImplementation(
      gatewayHealthResponse({
        error: restart.gatewayResponseError("missing scope: operator.read"),
        server: { version: "2026.4.24", connId: "new" },
      }),
    );

    const snapshot = await restart.inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: ownedPortUsage,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(snapshot.probeError).toBe("missing scope: operator.read");
  });

  it.each(["version", "build"] as const)("stops waiting on a wrong %s identity", async (kind) => {
    const isVersion = kind === "version";
    const expected = isVersion ? "2026.4.24" : "new-build";
    const actual = isVersion ? "2026.4.23" : "old-build";
    const snapshot = await waitForHealth(
      {
        server: {
          version: isVersion ? actual : "2026.4.24",
          ...(isVersion ? {} : { buildId: actual }),
          connId: "old",
        },
      },
      isVersion ? {} : { expectedVersion: undefined, expectedBuildId: expected },
    );
    expect(snapshot).toMatchObject({
      healthy: false,
      elapsedMs: 0,
      waitOutcome: isVersion ? "version-mismatch" : "build-id-mismatch",
      [isVersion ? "gatewayVersion" : "gatewayBuildId"]: actual,
      [isVersion ? "expectedVersion" : "expectedBuildId"]: expected,
    });
    expect(isVersion ? snapshot.versionMismatch : snapshot.buildIdMismatch).toEqual({
      expected,
      actual,
    });
    expect(restart.sleep).not.toHaveBeenCalled();
    if (!isVersion) {
      expect(renderRestartDiagnostics(snapshot)).toContain(
        "Gateway build mismatch: expected new-build, running gateway reported old-build.",
      );
    }
  });

  it.each(["plugin", "channel"] as const)("stops waiting on %s errors", async (kind) => {
    const disabled = { id: "optional", activated: false, error: "disabled plugin ignored" };
    const activated = {
      id: "telegram",
      origin: "bundled",
      activated: true,
      error: "failed to load plugin dependency: ENOSPC",
    };
    const snapshot = await waitForHealth({
      health: {
        ok: true,
        ...(kind === "plugin"
          ? { plugins: { errors: [activated, disabled] } }
          : {
              channels: {
                telegram: {
                  configured: true,
                  probe: { ok: false, error: "This operation was aborted" },
                },
              },
            }),
      },
    });
    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: kind === "plugin" ? "plugin-errors" : "channel-errors",
      elapsedMs: 0,
    });
    expect(restart.sleep).not.toHaveBeenCalled();
    if (kind === "plugin") {
      expect(snapshot).toMatchObject({ gatewayVersion: "2026.4.24", expectedVersion: "2026.4.24" });
      expect(snapshot.activatedPluginErrors).toEqual([activated]);
      expect(snapshot.versionMismatch).toBeUndefined();
      expect(restart.callGateway.mock.calls[0]?.[0]).toMatchObject({
        method: "health",
        scopes: ["operator.read"],
      });
      expect(renderRestartDiagnostics(snapshot).join("\n")).toContain(
        "Activated plugin load errors:\n- telegram: failed to load plugin dependency: ENOSPC",
      );
    } else {
      expect(snapshot.channelProbeErrors).toEqual([
        { id: "telegram", error: "This operation was aborted" },
      ]);
    }
  });
});
