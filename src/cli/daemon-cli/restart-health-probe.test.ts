// Gateway restart probe and health-detail tests.
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainGatewayResponsePayload } from "../../../packages/gateway-client/src/protocol-request.js";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import { GatewayCredentialsRequiredError } from "../../gateway/call-device-auth.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { createGatewayCloseTransportError } from "../../gateway/transport-error.js";
import { createGatewayRestartDeadline } from "./restart-health-deadline.js";
import {
  inspectGatewayRestartWithSnapshot,
  inspectPortUsage,
  makeGatewayService,
  portUsage,
  waitForRunningGateway,
  monotonicClock,
  callGateway,
  gatewayResponseError,
  requestReadinessProbe,
  requestStartupProbe,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

const ownedPortUsage = portUsage([{ pid: 8000, commandLine: "openclaw-gateway" }]);
const running = { status: "running", pid: 8000 } as const;

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it("keeps native inspection and health RPC within one supplied allowance", async () => {
    const service = makeGatewayService(running);
    vi.mocked(service.readRuntime).mockImplementation(async () => {
      monotonicClock.nowMs += 25_000;
      return { status: "running", pid: 8000 };
    });
    inspectPortUsage.mockResolvedValue(ownedPortUsage);
    callGateway.mockImplementation(async (opts) => {
      const responseMs = 10_000;
      const allowanceMs = opts.timeoutMs ?? responseMs;
      monotonicClock.nowMs += Math.min(allowanceMs, responseMs);
      if (allowanceMs < responseMs) {
        throw new Error("gateway request timeout for health");
      }
      return gatewayHealthResponse({ server: { version: "2026.9.3" } })(opts);
    });
    const { inspectGatewayRestart } = await import("./restart-health.js");
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
      expect(monotonicClock.nowMs).toBe(30_000);
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
    if (!address || typeof address === "string") {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      throw new Error("expected loopback server address");
    }

    try {
      const { waitForGatewayHttpReadiness } = await import("./restart-health-probe.js");
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
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  });

  it.each([
    "{broken",
    "null",
    JSON.stringify({ ready: false, coreReady: true, failing: "telegram" }),
    JSON.stringify({ ready: false, coreReady: true, failing: [" "] }),
  ])("does not accept malformed channel readiness: %s", async (body) => {
    requestReadinessProbe.mockImplementation(async ({ pathname }) => ({
      statusCode: pathname === "/healthz" ? 200 : 503,
      body: pathname === "/healthz" ? "" : body,
    }));
    const { waitForGatewayHttpReadiness } = await import("./restart-health-probe.js");
    await expect(
      waitForGatewayHttpReadiness({
        attempts: 1,
        deadlineAt: performance.now() + 1_000,
        delayMs: 0,
        port: 18789,
        requireChannelHealth: false,
      }),
    ).resolves.toEqual({ healthz: 200, readyz: 503, coreReady: false });
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
    callGateway.mockRejectedValue(
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
          : gatewayResponseError(reason),
    );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);
    requestStartupProbe.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        status: "started",
        version: "2026.10.4",
        buildId: scenario.build,
      }),
    });
    requestReadinessProbe.mockResolvedValue({
      statusCode: scenario.ready ? 200 : 503,
      body: JSON.stringify({ ready: scenario.ready }),
    });
    const snapshot = await waitForRunningGateway({
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
    expect(callGateway).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    { build: "candidate-build", outcome: "healthy" },
    { build: "old-build", outcome: "build-id-mismatch" },
  ])("settles an RPC protocol mismatch through HTTP identity ($build)", async (scenario) => {
    // The updater runs the previous package, so a protocol bump or revert rejects its handshake.
    const mismatch = new GatewayClientRequestError({
      code: "INVALID_REQUEST",
      message: "protocol mismatch",
      details: {
        code: "PROTOCOL_MISMATCH",
        clientMinProtocol: 5,
        clientMaxProtocol: 5,
        expectedProtocol: 4,
        minimumProbeProtocol: 3,
      },
    });
    retainGatewayResponsePayload(mismatch, undefined);
    callGateway.mockRejectedValue(mismatch);
    inspectPortUsage.mockResolvedValue(ownedPortUsage);
    requestStartupProbe.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        status: "started",
        version: "2026.10.6",
        buildId: scenario.build,
      }),
    });
    requestReadinessProbe.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ ready: true }),
    });
    const snapshot = await waitForRunningGateway({
      expectedVersion: "2026.10.6",
      expectedBuildId: "candidate-build",
      requirePluginHealth: false,
      requireChannelHealth: false,
      timeoutMs: 1_800_000,
      delayMs: 30_000,
    });
    expect(snapshot.waitOutcome).toBe(scenario.outcome);
    expect(snapshot.protocolMismatch).toBe(
      "protocol mismatch: Control UI v5, Gateway v4, connection check min v3",
    );
    expect(snapshot.authenticationError).toBeUndefined();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("keeps the readiness deadline monotonic when the wall clock rewinds", async () => {
    // A wall-clock rewind must not extend the monotonic readiness budget.
    requestReadinessProbe.mockImplementation(async () => {
      monotonicClock.nowMs += 20;
      return null;
    });
    const wallClockRewindMs = 300_000;
    const wallClockSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() - wallClockRewindMs);
    const deadlineBudgetMs = 50;
    const deadlineAt = performance.now() + deadlineBudgetMs;
    const { waitForGatewayHttpReadiness } = await import("./restart-health-probe.js");
    await expect(
      waitForGatewayHttpReadiness({
        attempts: 100,
        deadlineAt,
        delayMs: 0,
        port: 18789,
      }),
    ).resolves.toEqual({ healthz: null, readyz: null });
    wallClockSpy.mockRestore();
    expect(monotonicClock.nowMs).toBeLessThan(wallClockRewindMs);
    expect(monotonicClock.nowMs).toBeGreaterThanOrEqual(deadlineBudgetMs);
    expect(requestReadinessProbe.mock.calls.length).toBeLessThan(200);
  });

  it("preserves the June stale reason through the sanitized health-probe boundary", async () => {
    const service = makeGatewayService(running);
    inspectPortUsage.mockResolvedValue(ownedPortUsage);
    callGateway.mockRejectedValueOnce(
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
    const { inspectGatewayRestart } = await import("./restart-health.js");
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
    callGateway.mockRejectedValueOnce(new Error(failure));

    const { confirmGatewayReachable } = await import("./restart-health-probe.js");
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
    callGateway
      .mockImplementationOnce(
        gatewayHealthResponse({
          error: new Error("timeout"),
          server: { version: "2026.4.24", connId: "first" },
        }),
      )
      .mockImplementationOnce(
        gatewayHealthResponse({
          server: { version: "2026.4.24", connId: "next" },
        }),
      );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const snapshot = await waitForRunningGateway({
      expectedVersion: "2026.4.24",
      attempts: 2,
      delayMs: 500,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.probeError).toBeUndefined();
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("rejects matching-version restart readiness when health lacks operator scope", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        error: gatewayResponseError("missing scope: operator.read"),
        server: { version: "2026.4.24", connId: "new" },
      }),
    );

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: ownedPortUsage,
    });

    expect(snapshot).toMatchObject({
      healthy: false,
      gatewayVersion: "2026.4.24",
      expectedVersion: "2026.4.24",
      probeError: "missing scope: operator.read",
    });
    expect(snapshot.versionMismatch).toBeUndefined();
  });

  it.each([
    {
      server: { version: "2026.4.23", connId: "old" },
      options: { expectedVersion: "2026.4.24" },
      expected: {
        waitOutcome: "version-mismatch",
        gatewayVersion: "2026.4.23",
        expectedVersion: "2026.4.24",
        versionMismatch: { expected: "2026.4.24", actual: "2026.4.23" },
      },
    },
    {
      server: { version: "2026.4.24", buildId: "old-build", connId: "old" },
      options: { expectedBuildId: "new-build" },
      expected: {
        waitOutcome: "build-id-mismatch",
        gatewayBuildId: "old-build",
        buildIdMismatch: { expected: "new-build", actual: "old-build" },
      },
    },
  ])("stops immediately on $expected.waitOutcome", async ({ server, options, expected }) => {
    callGateway.mockImplementation(gatewayHealthResponse({ server }));
    inspectPortUsage.mockResolvedValue(ownedPortUsage);
    const snapshot = await waitForRunningGateway(options);
    expect(snapshot).toMatchObject({ healthy: false, elapsedMs: 0, ...expected });
    expect(sleep).not.toHaveBeenCalled();
    if (options.expectedBuildId) {
      expect(snapshot.buildIdMismatch).toEqual(expected.buildIdMismatch);
      const { renderRestartDiagnostics } = await import("./restart-health.js");
      expect(renderRestartDiagnostics(snapshot)).toContain(
        "Gateway build mismatch: expected new-build, running gateway reported old-build.",
      );
    }
  });

  it("stops waiting once the expected-version gateway reports activated plugin errors", async () => {
    const pluginError = {
      id: "telegram",
      origin: "bundled",
      activated: true,
      error: "failed to load plugin dependency: ENOSPC",
    };
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "new" },
        health: {
          ok: true,
          plugins: {
            errors: [
              pluginError,
              {
                id: "optional",
                origin: "workspace",
                activated: false,
                error: "disabled plugin ignored",
              },
            ],
          },
        },
      }),
    );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const snapshot = await waitForRunningGateway({
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("plugin-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.activatedPluginErrors).toEqual([pluginError]);
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(callGateway.mock.calls[0]?.[0]).toMatchObject({
      method: "health",
      scopes: ["operator.read"],
    });
    expect(sleep).not.toHaveBeenCalled();

    const { renderRestartDiagnostics } = await import("./restart-health.js");
    expect(renderRestartDiagnostics(snapshot).join("\n")).toContain(
      "Activated plugin load errors:\n- telegram: failed to load plugin dependency: ENOSPC",
    );
  });

  it("stops waiting once the expected-version gateway reports channel probe errors", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "new" },
        health: {
          ok: true,
          channels: {
            telegram: {
              configured: true,
              probe: { ok: false, error: "This operation was aborted" },
            },
          },
        },
      }),
    );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const snapshot = await waitForRunningGateway({
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("channel-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.channelProbeErrors).toEqual([
      { id: "telegram", error: "This operation was aborted" },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });
});
