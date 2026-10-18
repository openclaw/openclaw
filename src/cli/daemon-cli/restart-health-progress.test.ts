import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import * as restart from "./restart-health.test-helpers.js";

const { waitForGatewayHealthyRestart, formatGatewayRestartFailure } =
  await import("./restart-health.js");

function listenWhen(ready: () => boolean, pid = 8000) {
  restart.inspectPortUsage.mockImplementation(async (port) =>
    restart.portUsage(ready() ? [{ pid }] : [], { port }),
  );
}

const failure = (health: Awaited<ReturnType<typeof waitForGatewayHealthyRestart>>) =>
  formatGatewayRestartFailure({ health, port: 18789, defaultTimeoutSeconds: 60 }).failMessage;

describe("restart startup progress", () => {
  beforeEach(restart.resetRestartHealthMocks);
  afterEach(restart.restoreRestartHealthMocks);

  it.each(["starting", "draining"])("distinguishes HTTP %s from readiness", async (status) => {
    const starting = status === "starting";
    restart.inspectPortUsage.mockResolvedValue(restart.portUsage([{ pid: 8000 }]));
    restart.requestStartupProbe.mockResolvedValue({
      statusCode: 503,
      body: JSON.stringify({ status, pendingReason: starting ? "plugin-convergence" : "shutdown" }),
    });
    restart.callGateway.mockImplementation(gatewayHealthResponse());
    const onProgress = vi.fn();
    const result = await restart.waitForRunningGateway({
      requirePluginHealth: false,
      timeoutMs: starting ? 60_000 : undefined,
      onProgress,
    });
    expect(result).toMatchObject(
      starting
        ? {
            healthy: false,
            waitOutcome: "still-starting",
            elapsedMs: 60_000,
            startupPhase: "plugin-convergence",
          }
        : { healthy: true, waitOutcome: "healthy", elapsedMs: 0 },
    );
    if (starting) {
      expect(onProgress).toHaveBeenCalledWith("plugin-convergence");
      expect(restart.callGateway).toHaveBeenCalledTimes(0);
    }
  });

  it("does not let HTTP startup hide an owned listener running the wrong build", async () => {
    restart.inspectPortUsage.mockResolvedValue(restart.portUsage([{ pid: 8000 }]));
    restart.requestStartupProbe.mockResolvedValue({
      statusCode: 503,
      body: '{"status":"starting","pendingReason":"plugin-convergence"}',
    });
    restart.callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "previous-version", buildId: "previous-build" },
      }),
    );
    const result = await restart.waitForRunningGateway({
      timeoutMs: 2_000,
      requireRunningService: true,
      requirePluginHealth: false,
      expectedBuildId: "candidate-build",
    });
    expect(result).toMatchObject({
      healthy: false,
      waitOutcome: "build-id-mismatch",
    });
    expect(result.buildIdMismatch).toEqual({
      expected: "candidate-build",
      actual: "previous-build",
    });
    expect(failure(result)).toMatch(/build did not match/);
  });

  it.each([null, 1])("observes delayed child readiness with exitCode=%s", async (exitCode) => {
    const child = { pid: process.pid, exitCode, signalCode: null };
    listenWhen(() => restart.monotonicClock.nowMs >= 12_500, child.pid);
    restart.callGateway.mockImplementation(async (opts) => {
      if (restart.monotonicClock.nowMs < 20_000) {
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
    const service = restart.makeGatewayService({ status: "running", pid: 8000 });
    vi.mocked(service.readRuntime).mockImplementation(async () =>
      restart.monotonicClock.nowMs < 45_000
        ? { status: "unknown" }
        : { status: "running", pid: 8000 },
    );
    listenWhen(() => restart.monotonicClock.nowMs >= 95_000);
    restart.callGateway.mockImplementation(async (opts) => {
      if (restart.monotonicClock.nowMs >= 145_000) {
        await gatewayHealthResponse({ server: { bootId: "stable-boot" } })(opts);
      }
      if (restart.monotonicClock.nowMs < 180_000) {
        throw new Error("Gateway health is not ready");
      }
      return {};
    });
    const health = await restart.waitForRunningGateway({
      service,
      requirePluginHealth: false,
    });
    expect(health).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 180_000 });
  });

  const migration = (
    name: string,
    elapsedMs: number,
    options: {
      foreignAt?: number;
      releasedAt?: number;
      renewUntil?: number;
      errorAt?: number;
      listenerPhase?: boolean;
      readyAt?: number;
      jitter?: number;
      healthy?: boolean;
      updateInProgress?: boolean;
    } = {},
  ) => ({ name, elapsedMs, ...options });
  it.each([
    migration("delayed heartbeat", 90_250, { readyAt: 90_000, jitter: 250, healthy: true }),
    migration("release before readiness", 145_000, {
      releasedAt: 120_000,
      readyAt: 145_000,
      healthy: true,
    }),
    migration("stalled renewal", 130_000, { renewUntil: 61_000, readyAt: 145_000 }),
    migration("foreign migration completion", 130_000, {
      foreignAt: 90_000,
      releasedAt: 120_000,
      readyAt: 145_000,
      listenerPhase: true,
    }),
    migration("migration completion credited once", 180_000, {
      releasedAt: 120_000,
      listenerPhase: true,
    }),
    migration("migration poll failure", 130_000, {
      renewUntil: 61_000,
      errorAt: 120_000,
      readyAt: 145_000,
      listenerPhase: true,
    }),
    migration("renewing migration", 300_000),
    migration("renewing migration under updater", 300_000, { updateInProgress: true }),
  ])(
    "bounds a $name",
    async ({
      elapsedMs,
      foreignAt,
      releasedAt,
      renewUntil,
      errorAt,
      listenerPhase,
      readyAt,
      jitter,
      healthy = false,
      updateInProgress,
    }) => {
      const service = restart.makeGatewayService({ status: "running", pid: 8000 });
      if (readyAt !== undefined) {
        listenWhen(() => restart.monotonicClock.nowMs >= readyAt);
        restart.callGateway.mockImplementation(
          gatewayHealthResponse({ server: { bootId: "stable-boot" } }),
        );
      }
      if (jitter) {
        vi.mocked(service.readRuntime).mockImplementation(async () => {
          if (restart.monotonicClock.nowMs === 60_000) {
            restart.monotonicClock.nowMs += jitter;
          }
          return { status: "running", pid: 8000 };
        });
      }
      const isStartupMigrationActive: NonNullable<
        Parameters<typeof waitForGatewayHealthyRestart>[0]["isStartupMigrationActive"]
      > = ({ onActivity } = {}) => {
        if (restart.monotonicClock.nowMs >= (errorAt ?? Infinity)) {
          throw new Error("Migration activity unavailable");
        }
        if (
          restart.monotonicClock.nowMs < 1_000 ||
          restart.monotonicClock.nowMs >= (releasedAt ?? Infinity)
        ) {
          return false;
        }
        const foreignLease = restart.monotonicClock.nowMs >= (foreignAt ?? Infinity);
        const renewedAt = Math.min(restart.monotonicClock.nowMs, renewUntil ?? Infinity);
        onActivity?.({
          owner: foreignLease ? "foreign-migration-owner" : "migration-owner",
          pid: foreignLease ? 9000 : 8000,
          heartbeatAt: 1_000 + Math.floor((renewedAt - 1_000) / 60_000) * 60_000,
        });
        return true;
      };
      const health = await restart.waitForRunningGateway({
        service,
        isStartupMigrationActive,
        requirePluginHealth: false,
        env: updateInProgress ? { OPENCLAW_UPDATE_IN_PROGRESS: "1" } : {},
      });
      expect(health).toMatchObject({
        healthy,
        waitOutcome: healthy ? "healthy" : "still-starting",
        elapsedMs,
      });
      if (!healthy) {
        const message = failure(health);
        expect(message).toContain(`still starting after ${elapsedMs / 1000}s`);
        expect(message).toContain(
          listenerPhase ? "waiting for Gateway listener" : "startup migration",
        );
        expect(message).toContain("openclaw gateway status --deep");
      }
    },
  );

  it.each([
    { listenerPid: 8000, elapsedMs: 90_000 },
    { listenerPid: 9000, elapsedMs: 60_000 },
  ])(
    "only credits new listener progress owned by the service (pid=$listenerPid)",
    async ({ listenerPid, elapsedMs }) => {
      listenWhen(() => Math.floor(restart.monotonicClock.nowMs / 30_000) % 2 !== 0, listenerPid);
      const health = await restart.waitForRunningGateway({
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
