import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  requestStartupProbe,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const { waitForGatewayHealthyRestart, formatGatewayRestartFailure } =
  await import("./restart-health.js");

describe("restart startup progress", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each([
    { name: "advancing startup", advances: true, expected: "healthy", elapsedMs: 90_000 },
    { name: "stalled startup", expected: "still-starting", elapsedMs: 60_000 },
    {
      name: "replayed phases",
      advances: true,
      repeats: true,
      readyAtMs: 180_000,
      expected: "still-starting",
      elapsedMs: 105_000,
    },
    {
      name: "another process's phases",
      advances: true,
      replaced: true,
      expected: "still-starting",
      elapsedMs: 60_000,
    },
    {
      name: "explicit deadline",
      advances: true,
      timeoutMs: 60_000,
      expected: "still-starting",
      elapsedMs: 60_000,
    },
    {
      name: "foreign listener phases",
      advances: true,
      listenerPid: 9000,
      expected: "timeout",
      elapsedMs: 60_000,
    },
    {
      name: "dead replacement",
      advances: true,
      dies: true,
      expected: "stopped-free",
      elapsedMs: 47_500,
    },
  ])(
    "observes $name without confusing progress with readiness",
    async ({
      advances,
      repeats,
      replaced,
      readyAtMs = 90_000,
      timeoutMs,
      listenerPid,
      dies,
      expected,
      elapsedMs,
    }) => {
      const runtimePid = () => (replaced && monotonicClock.nowMs >= 45_000 ? 8001 : 8000);
      const service = makeGatewayService({ status: "running", pid: 8000 });
      vi.mocked(service.readRuntime).mockImplementation(async () =>
        dies && monotonicClock.nowMs >= 45_000
          ? { status: "stopped" }
          : { status: "running", pid: runtimePid() },
      );
      inspectPortUsage.mockImplementation(async () => ({
        port: 18789,
        status: dies && monotonicClock.nowMs >= 45_000 ? "free" : "busy",
        listeners:
          dies && monotonicClock.nowMs >= 45_000 ? [] : [{ pid: listenerPid ?? runtimePid() }],
        hints: [],
      }));
      requestStartupProbe.mockImplementation(async () => ({
        statusCode: monotonicClock.nowMs < readyAtMs ? 503 : 200,
        body: JSON.stringify(
          monotonicClock.nowMs < readyAtMs
            ? {
                status: "starting",
                pendingReason:
                  advances &&
                  monotonicClock.nowMs >= 45_000 &&
                  !(repeats && monotonicClock.nowMs >= 75_000 && monotonicClock.nowMs < 105_000)
                    ? "agent-database-inspection"
                    : "startup-sidecars",
              }
            : { status: "started" },
        ),
      }));
      callGateway.mockImplementation(gatewayHealthResponse());
      const onProgress = vi.fn();
      const result = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        requirePluginHealth: false,
        timeoutMs,
        onProgress,
      });
      expect(result).toMatchObject({
        healthy: expected === "healthy",
        waitOutcome: expected,
        elapsedMs,
      });
      expect(onProgress).toHaveBeenCalledWith("startup-sidecars");
      if (expected === "healthy") {
        expect(callGateway).toHaveBeenCalledOnce();
      } else {
        expect(callGateway).not.toHaveBeenCalled();
      }
    },
  );

  it.each([{ statusCode: 503, body: '{"status":"draining","pendingReason":"shutdown"}' }])(
    "does not mistake another HTTP readiness outcome for startup: %j",
    async (response) => {
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000 }],
        hints: [],
      });
      requestStartupProbe.mockResolvedValue(response);
      callGateway.mockImplementation(gatewayHealthResponse());
      const result = await waitForGatewayHealthyRestart({
        service: makeGatewayService({ status: "running", pid: 8000 }),
        port: 18789,
        requirePluginHealth: false,
      });
      expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 0 });
    },
  );

  it.each([
    {
      name: "owned listener running the wrong build",
      listenerPid: 8000,
      expectedBuildId: "candidate-build",
      outcome: "build-id-mismatch",
      failureReason: /build did not match/,
    },
  ])(
    "does not let HTTP startup hide $name",
    async ({ listenerPid, expectedBuildId, outcome, failureReason }) => {
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: listenerPid }],
        hints: [],
      });
      requestStartupProbe.mockResolvedValue({
        statusCode: 503,
        body: '{"status":"starting","pendingReason":"plugin-convergence"}',
      });
      callGateway.mockImplementation(
        gatewayHealthResponse({
          server: { version: "previous-version", buildId: "previous-build" },
        }),
      );
      const result = await waitForGatewayHealthyRestart({
        service: makeGatewayService({ status: "running", pid: 8000 }),
        port: 18789,
        timeoutMs: 2_000,
        requireRunningService: true,
        requirePluginHealth: false,
        expectedBuildId,
      });
      expect(result).toMatchObject({ healthy: false, waitOutcome: outcome });
      expect(
        formatGatewayRestartFailure({ health: result, port: 18789, defaultTimeoutSeconds: 60 })
          .failMessage,
      ).toMatch(failureReason);
      expect(result.buildIdMismatch).toEqual({
        expected: expectedBuildId,
        actual: "previous-build",
      });
    },
  );

  it.each([null, 1])("observes delayed child readiness with exitCode=%s", async (exitCode) => {
    const child = { pid: process.pid, exitCode, signalCode: null };
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: monotonicClock.nowMs < 12_500 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 12_500 ? [] : [{ pid: child.pid }],
      hints: [],
    }));
    callGateway.mockImplementation(async (opts) => {
      if (monotonicClock.nowMs < 20_000) {
        throw new Error("Gateway is still starting");
      }
      return gatewayHealthResponse({ server: { version: "2026.9.4", bootId: "child-boot" } })(opts);
    });
    const health = await waitForGatewayHealthyRestart({
      child,
      port: 18789,
      requireRunningService: true,
      requirePluginHealth: false,
      expectedVersion: "2026.9.4",
    });
    if (exitCode === null) {
      expect(health).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 20_000 });
    } else {
      expect(health.runtime.status).toBe("stopped");
      expect(health.waitOutcome).not.toBe("healthy");
    }
  });

  it("waits through advancing service, listener, and hello phases until health at 180s", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    vi.mocked(service.readRuntime).mockImplementation(async () =>
      monotonicClock.nowMs < 45_000 ? { status: "unknown" } : { status: "running", pid: 8000 },
    );
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: monotonicClock.nowMs < 95_000 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 95_000 ? [] : [{ pid: 8000 }],
      hints: [],
    }));
    callGateway.mockImplementation(async (opts) => {
      if (monotonicClock.nowMs >= 145_000) {
        await gatewayHealthResponse({ server: { bootId: "stable-boot" } })(opts);
      }
      if (monotonicClock.nowMs < 180_000) {
        throw new Error("Gateway health is not ready");
      }
      return {};
    });
    const health = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      requirePluginHealth: false,
    });
    expect(health).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 180_000 });
  });

  it.each([
    {
      name: "heartbeat observed after polling delay",
      readyAtMs: 90_000,
      pollJitterMs: 250,
      expected: "healthy",
      elapsedMs: 90_250,
    },
    {
      name: "migration released at 120s before readiness at 145s",
      releaseAtMs: 120_000,
      readyAtMs: 145_000,
      expected: "healthy",
      elapsedMs: 145_000,
    },
    {
      name: "migration stalled after its 61s renewal without completing",
      renewUntilMs: 61_000,
      readyAtMs: 145_000,
      expected: "still-starting",
      elapsedMs: 130_000,
    },
    {
      name: "foreign migration completion after the observed lease is replaced",
      foreignAfterMs: 90_000,
      releaseAtMs: 120_000,
      readyAtMs: 145_000,
      expected: "still-starting",
      elapsedMs: 130_000,
      phase: "waiting for Gateway listener",
    },
    {
      name: "migration completion credited only once",
      releaseAtMs: 120_000,
      expected: "still-starting",
      elapsedMs: 180_000,
      phase: "waiting for Gateway listener",
    },
    {
      name: "migration poll failure without observed completion",
      renewUntilMs: 61_000,
      pollErrorAtMs: 120_000,
      readyAtMs: 145_000,
      expected: "still-starting",
      elapsedMs: 130_000,
      phase: "waiting for Gateway listener",
    },
    { name: "renewing migration", expected: "still-starting", elapsedMs: 300_000 },
    {
      name: "renewing migration under a published updater",
      updateInProgress: true,
      expected: "still-starting",
      elapsedMs: 300_000,
    },
  ])(
    "bounds a $name",
    async ({
      foreignAfterMs,
      releaseAtMs,
      renewUntilMs,
      pollErrorAtMs,
      phase,
      readyAtMs,
      pollJitterMs,
      expected,
      elapsedMs,
      updateInProgress,
    }) => {
      const service = makeGatewayService({ status: "running", pid: 8000 });
      if (readyAtMs !== undefined) {
        inspectPortUsage.mockImplementation(async (port) => ({
          port,
          status: monotonicClock.nowMs < readyAtMs ? "free" : "busy",
          listeners: monotonicClock.nowMs < readyAtMs ? [] : [{ pid: 8000 }],
          hints: [],
        }));
        callGateway.mockImplementation(
          gatewayHealthResponse({ server: { bootId: "stable-boot" } }),
        );
      }
      if (pollJitterMs) {
        vi.mocked(service.readRuntime).mockImplementation(async () => {
          if (monotonicClock.nowMs === 60_000) {
            monotonicClock.nowMs += pollJitterMs;
          }
          return { status: "running", pid: 8000 };
        });
      }
      const isStartupMigrationActive = ({
        onActivity,
      }: {
        env?: NodeJS.ProcessEnv;
        onActivity?: (activity: {
          owner: string;
          pid?: number;
          heartbeatAt: number | null;
        }) => void;
      } = {}) => {
        if (monotonicClock.nowMs >= (pollErrorAtMs ?? Infinity)) {
          throw new Error("Migration activity unavailable");
        }
        if (monotonicClock.nowMs < 1_000 || monotonicClock.nowMs >= (releaseAtMs ?? Infinity)) {
          return false;
        }
        const foreignLease = monotonicClock.nowMs >= (foreignAfterMs ?? Infinity);
        onActivity?.({
          owner: foreignLease ? "foreign-migration-owner" : "migration-owner",
          pid: foreignLease ? 9000 : 8000,
          heartbeatAt:
            1_000 +
            Math.floor(
              (Math.min(monotonicClock.nowMs, renewUntilMs ?? Infinity) - 1_000) / 60_000,
            ) *
              60_000,
        });
        return true;
      };
      const health = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        isStartupMigrationActive,
        requirePluginHealth: false,
        env: updateInProgress ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {},
      });
      expect(health).toMatchObject({
        healthy: expected === "healthy",
        waitOutcome: expected,
        elapsedMs,
      });
      const message = formatGatewayRestartFailure({
        health,
        port: 18789,
        defaultTimeoutSeconds: 60,
      });
      if (expected === "still-starting") {
        expect(message.failMessage).toContain(`still starting after ${elapsedMs / 1000}s`);
        expect(message.failMessage).toContain(phase ?? "startup migration");
        expect(message.failMessage).toContain("openclaw gateway status --deep");
      }
    },
  );

  it.each([
    { listenerPid: 8000, elapsedMs: 90_000 },
    { listenerPid: 9000, elapsedMs: 60_000 },
  ])(
    "only credits new listener progress owned by the service (pid=$listenerPid)",
    async ({ listenerPid, elapsedMs }) => {
      inspectPortUsage.mockImplementation(async (port) => ({
        port,
        status: Math.floor(monotonicClock.nowMs / 30_000) % 2 === 0 ? "free" : "busy",
        listeners:
          Math.floor(monotonicClock.nowMs / 30_000) % 2 === 0 ? [] : [{ pid: listenerPid }],
        hints: [],
      }));
      const health = await waitForGatewayHealthyRestart({
        service: makeGatewayService({ status: "running", pid: 8000 }),
        port: 18789,
        requirePluginHealth: false,
      });
      expect(health).toMatchObject({
        healthy: false,
        waitOutcome: listenerPid === 8000 ? "timeout" : "still-starting",
        elapsedMs,
      });
    },
  );
});
