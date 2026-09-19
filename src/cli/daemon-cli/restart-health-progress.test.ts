import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const { waitForGatewayHealthyRestart, formatGatewayRestartFailure } =
  await import("./restart-health.js");

describe("restart startup progress", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

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
      name: "lease acquired at 1s with its first heartbeat at 61s",
      renew: true,
      readyAtMs: 90_000,
      expected: "healthy",
      elapsedMs: 90_000,
    },
    {
      name: "heartbeat observed after polling delay",
      renew: true,
      readyAtMs: 90_000,
      pollJitterMs: 250,
      expected: "healthy",
      elapsedMs: 90_250,
    },
    {
      name: "migration released at 120s before readiness at 145s",
      renew: true,
      releaseAtMs: 120_000,
      readyAtMs: 145_000,
      expected: "healthy",
      elapsedMs: 145_000,
    },
    {
      name: "migration stalled after its 61s renewal without completing",
      renew: true,
      renewUntilMs: 61_000,
      readyAtMs: 145_000,
      expected: "timeout",
      elapsedMs: 130_000,
    },
    {
      name: "foreign migration completion after the observed lease is replaced",
      renew: true,
      foreignAfterMs: 90_000,
      releaseAtMs: 120_000,
      readyAtMs: 145_000,
      expected: "timeout",
      elapsedMs: 130_000,
    },
    {
      name: "migration completion credited only once",
      renew: true,
      releaseAtMs: 120_000,
      expected: "timeout",
      elapsedMs: 180_000,
    },
    {
      name: "migration poll failure without observed completion",
      renew: true,
      renewUntilMs: 61_000,
      pollErrorAtMs: 120_000,
      readyAtMs: 145_000,
      expected: "timeout",
      elapsedMs: 130_000,
    },
    {
      name: "migration completion at the five-minute cap",
      renew: true,
      releaseAtMs: 290_000,
      readyAtMs: 310_000,
      expected: "still-starting",
      elapsedMs: 300_000,
      phase: "waiting for Gateway listener",
    },
    { name: "renewing migration", renew: true, expected: "still-starting", elapsedMs: 300_000 },
    {
      name: "renewing migration during update verification",
      renew: true,
      timeoutMs: 300_000,
      expected: "still-starting",
      elapsedMs: 300_000,
    },
    {
      name: "renewing migration under a published updater",
      renew: true,
      updateInProgress: true,
      expected: "still-starting",
      elapsedMs: 300_000,
    },
    {
      name: "migration that stops making progress during update verification",
      renew: true,
      renewUntilMs: 30_000,
      timeoutMs: 300_000,
      expected: "timeout",
      elapsedMs: 300_000,
    },
    { name: "stalled migration", renew: false, expected: "timeout", elapsedMs: 70_000 },
    {
      name: "replaced process",
      renew: true,
      replace: true,
      expected: "generation-changed",
      elapsedMs: 60_000,
    },
    {
      name: "replaced boot under the same PID",
      renew: true,
      replaceBoot: true,
      expected: "generation-changed",
      elapsedMs: 60_000,
    },
    {
      name: "unrelated migration",
      renew: true,
      foreign: true,
      expected: "timeout",
      elapsedMs: 60_000,
    },
  ])(
    "bounds a $name",
    async ({
      renew,
      replace,
      replaceBoot,
      foreign,
      foreignAfterMs,
      releaseAtMs,
      renewUntilMs,
      pollErrorAtMs,
      phase,
      readyAtMs,
      pollJitterMs,
      expected,
      elapsedMs,
      timeoutMs,
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
      if (replace) {
        vi.mocked(service.readRuntime).mockImplementation(async () => ({
          status: "running",
          pid: monotonicClock.nowMs < 30_000 ? 8000 : 9000,
        }));
      }
      if (replaceBoot) {
        inspectPortUsage.mockResolvedValue({
          port: 18789,
          status: "busy",
          listeners: [{ pid: 8000 }],
          hints: [],
        });
        callGateway.mockImplementation((opts) =>
          gatewayHealthResponse({
            server: { bootId: monotonicClock.nowMs < 30_000 ? "boot-a" : "boot-b" },
            error: new Error("Gateway health is not ready"),
          })(opts),
        );
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
        const foreignLease = foreign || monotonicClock.nowMs >= (foreignAfterMs ?? Infinity);
        onActivity?.({
          owner: foreignLease ? "foreign-migration-owner" : "migration-owner",
          pid: foreignLease ? 9000 : 8000,
          heartbeatAt: renew
            ? 1_000 +
              Math.floor(
                (Math.min(monotonicClock.nowMs, renewUntilMs ?? Infinity) - 1_000) / 60_000,
              ) *
                60_000
            : 1_000,
        });
        return true;
      };
      const health = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        isStartupMigrationActive,
        requirePluginHealth: false,
        timeoutMs,
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
        expect(message.failMessage).toContain("still starting after 300s");
        expect(message.failMessage).toContain(phase ?? "startup migration");
        expect(message.failMessage).toContain("openclaw gateway status --deep");
      } else if (expected === "timeout") {
        expect(message.failMessage).toBe(
          `Gateway restart timed out after ${elapsedMs / 1000}s waiting for health checks.`,
        );
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
      expect(health).toMatchObject({ healthy: false, waitOutcome: "timeout", elapsedMs });
    },
  );
});
