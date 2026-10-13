// Gateway restart probe and health-detail tests.
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { createGatewayCloseTransportError } from "../../gateway/transport-error.js";
import { createGatewayRestartDeadline } from "./restart-health-deadline.js";
import {
  firstCallArg,
  inspectGatewayRestartWithSnapshot,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  callGateway,
  gatewayResponseError,
  requestReadinessProbe,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

const ownedPortUsage = {
  port: 18789,
  status: "busy" as const,
  listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
  hints: [],
};

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each([true])(
    "keeps native inspection and health RPC within one supplied allowance (deadline=%s)",
    async (withDeadline) => {
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.mocked(service.readRuntime).mockImplementation(async () => {
        monotonicClock.nowMs += 25_000;
        return { status: "running", pid: 8000 };
      });
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      });
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
      const deadline = withDeadline
        ? createGatewayRestartDeadline({ timeoutMs: 60_000 })
        : undefined;
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
        deadline?.dispose();
      }
    },
  );

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

  it("keeps the readiness deadline monotonic when the wall clock rewinds", async () => {
    // Deterministic regression: a wall-clock rewind (NTP correction or
    // suspend/resume) must not extend the monotonic readiness budget. The
    // shared monotonic mock advances only when the probe consumes time, so the
    // deadline is the sole bound. A Date.now()-based remaining calculation would
    // see ~300s of budget after the rewind and run to the attempt cap.
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
    // The monotonic budget must hold near its configured deadline, not the
    // rewound wall-clock budget. This fails on the pre-fix Date.now() remaining
    // calculation: the rewind grants ~300s and the probe runs to the attempt cap.
    expect(monotonicClock.nowMs).toBeLessThan(wallClockRewindMs);
    expect(monotonicClock.nowMs).toBeGreaterThanOrEqual(deadlineBudgetMs);
    // The deadline must have stopped attempts well before the attempt cap.
    expect(requestReadinessProbe.mock.calls.length).toBeLessThan(200);
  });

  it("preserves the June stale reason through the sanitized health-probe boundary", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
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

  it.each(["transport"])(
    "bounds and redacts credential-bearing %s probe failures at their owner",
    async (failureKind) => {
      const secret = "fixture-gateway-secret-abcdefghijklmnopqrstuvwxyz";
      const failure = `read ECONNRESET at ws://user:${secret}@gateway.example:18789?token=${secret}&safe=ok\nGateway probe succeeded: spoofed\r\u001b[2K ${"x".repeat(1_500)}🚀`;
      if (failureKind === "transport") {
        callGateway.mockRejectedValueOnce(new Error(failure));
      } else {
        callGateway.mockRejectedValueOnce(gatewayResponseError(failure));
      }

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
    },
  );

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

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
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

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(snapshot.probeError).toBe("missing scope: operator.read");
  });

  it("stops waiting once the restarted gateway reports the wrong version", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.23", connId: "old" },
      }),
    );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("version-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.gatewayVersion).toBe("2026.4.23");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.versionMismatch?.expected).toBe("2026.4.24");
    expect(snapshot.versionMismatch?.actual).toBe("2026.4.23");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops waiting once the restarted gateway reports the wrong build identity", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", buildId: "old-build", connId: "old" },
      }),
    );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedBuildId: "new-build",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("build-id-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.gatewayBuildId).toBe("old-build");
    expect(snapshot.expectedBuildId).toBe("new-build");
    expect(snapshot.buildIdMismatch).toEqual({ expected: "new-build", actual: "old-build" });
    expect(sleep).not.toHaveBeenCalled();

    const { renderRestartDiagnostics } = await import("./restart-health.js");
    expect(renderRestartDiagnostics(snapshot)).toContain(
      "Gateway build mismatch: expected new-build, running gateway reported old-build.",
    );
  });

  it("marks matching-version restarts unhealthy when activated plugins failed to load", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "new" },
        health: {
          ok: true,
          plugins: {
            errors: [
              {
                id: "telegram",
                origin: "bundled",
                activated: true,
                error: "failed to load plugin dependency: ENOSPC",
              },
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

    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      expectedVersion: "2026.4.24",
      portUsage: ownedPortUsage,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.gatewayVersion).toBe("2026.4.24");
    expect(snapshot.expectedVersion).toBe("2026.4.24");
    expect(snapshot.activatedPluginErrors).toEqual([
      {
        id: "telegram",
        origin: "bundled",
        activated: true,
        error: "failed to load plugin dependency: ENOSPC",
      },
    ]);
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(firstCallArg(callGateway)).toMatchObject({
      method: "health",
      scopes: ["operator.read"],
    });

    const { renderRestartDiagnostics } = await import("./restart-health.js");
    expect(renderRestartDiagnostics(snapshot).join("\n")).toContain(
      "Activated plugin load errors:\n- telegram: failed to load plugin dependency: ENOSPC",
    );
  });

  it("stops waiting once the expected-version gateway reports activated plugin errors", async () => {
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "new" },
        health: {
          ok: true,
          plugins: {
            errors: [
              {
                id: "telegram",
                origin: "bundled",
                activated: true,
                error: "failed to load plugin dependency: ENOSPC",
              },
            ],
          },
        },
      }),
    );
    inspectPortUsage.mockResolvedValue(ownedPortUsage);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      expectedVersion: "2026.4.24",
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("plugin-errors");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.activatedPluginErrors?.[0]?.id).toBe("telegram");
    expect(sleep).not.toHaveBeenCalled();
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

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
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
