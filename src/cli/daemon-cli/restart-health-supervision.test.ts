import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  readBestEffortConfig,
  readGatewayOwnerLease,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

let waitForGatewayHealthyRestart: typeof import("./restart-health.js").waitForGatewayHealthyRestart;

describe("restart health supervision", () => {
  beforeEach(async () => {
    resetRestartHealthMocks();
    mockProcessPlatform("darwin");
    ({ waitForGatewayHealthyRestart } = await import("./restart-health.js"));
  });
  afterEach(restoreRestartHealthMocks);

  it("infers a loaded supervisor once and settles its late replacement generation", async () => {
    const env = { OPENCLAW_PROFILE: "work" };
    const service = makeGatewayService({ status: "running", pid: 4200 });
    vi.mocked(service.isLoaded).mockResolvedValue(true);
    vi.mocked(service.readRuntime).mockImplementation(async () =>
      monotonicClock.nowMs < 4000
        ? { status: "running", pid: 4200 }
        : monotonicClock.nowMs < 14_000
          ? { status: "stopped" }
          : { status: "running", pid: 4300 },
    );
    inspectPortUsage.mockImplementation(async () => ({
      port: 18789,
      status: monotonicClock.nowMs < 14_000 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 14_000 ? [] : [{ pid: 4300 }],
      hints: [],
    }));
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.9.4", buildId: "replacement-build", bootId: "replacement-boot" },
      }),
    );

    const snapshot = await waitForGatewayHealthyRestart({
      service,
      env,
      port: 18789,
      expectedVersion: "2026.9.4",
      expectedBuildId: "replacement-build",
      requireRunningService: true,
      settle: { probes: 12 },
    });
    expect(snapshot).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      elapsedMs: 19_500,
      runtime: { status: "running", pid: 4300 },
      gatewayBootId: "replacement-boot",
    });
    expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({ env, timeoutMs: 5000 });
    expect(service.readRuntime).toHaveBeenCalledTimes(40);
  });

  it.each(["unloaded", "unavailable"] as const)(
    "retains stopped-free failure when supervision is %s",
    async (state) => {
      const service = makeGatewayService({ status: "stopped" });
      if (state === "unavailable") {
        vi.mocked(service.isLoaded).mockRejectedValue(new Error("launchctl unavailable"));
      }
      const snapshot = await waitForGatewayHealthyRestart({ service, port: 18789 });
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "stopped-free",
        elapsedMs: 12_500,
      });
      expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({
        env: undefined,
        timeoutMs: 5000,
      });
    },
  );

  it.each([
    { platform: "darwin", supervisorKeepsAlive: true, elapsedMs: 60_000 },
    { platform: "darwin", supervisorKeepsAlive: false, elapsedMs: 12_500 },
    { platform: "linux", supervisorKeepsAlive: undefined, elapsedMs: 12_500 },
    { platform: "win32", supervisorKeepsAlive: undefined, elapsedMs: 32_500 },
  ] as const)(
    "preserves $platform explicit supervision=$supervisorKeepsAlive",
    async ({ platform, supervisorKeepsAlive, elapsedMs }) => {
      mockProcessPlatform(platform);
      const service = makeGatewayService({ status: "stopped" });
      vi.mocked(service.isLoaded).mockRejectedValue(new Error("unexpected supervisor query"));
      const snapshot = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
        supervisorKeepsAlive,
      });
      expect(snapshot.elapsedMs).toBe(elapsedMs);
      expect(service.isLoaded).not.toHaveBeenCalled();
    },
  );

  it.each([
    { timeoutMs: 10_000, preparationMs: 0, expectedTimeout: 5000 },
    { timeoutMs: 2000, preparationMs: 0, expectedTimeout: 2000 },
    { timeoutMs: 2000, preparationMs: 750, expectedTimeout: 1250 },
    { timeoutMs: 2000, preparationMs: 2000, expectedTimeout: undefined },
    { timeoutMs: 2000, preparationMs: 2500, expectedTimeout: undefined },
  ])(
    "bounds native inspection by the remaining $timeoutMs ms budget after $preparationMs ms",
    async ({ timeoutMs, preparationMs, expectedTimeout }) => {
      const env = { OPENCLAW_PROFILE: "bounded" };
      const service = makeGatewayService({ status: "stopped" });
      readBestEffortConfig.mockImplementation(async () => {
        monotonicClock.nowMs += preparationMs;
        return {};
      });
      vi.mocked(service.isLoaded).mockImplementation(async (args) => {
        expect(args.timeoutMs).toBe(expectedTimeout);
        monotonicClock.nowMs += args.timeoutMs ?? 0;
        return false;
      });
      const snapshot = await waitForGatewayHealthyRestart({
        service,
        env,
        port: 18789,
        timeoutMs,
      });
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: Math.max(timeoutMs, preparationMs),
      });
      if (expectedTimeout === undefined) {
        expect(service.isLoaded).not.toHaveBeenCalled();
      } else {
        expect(service.isLoaded).toHaveBeenCalledExactlyOnceWith({
          env,
          timeoutMs: expectedTimeout,
        });
      }
    },
  );

  it.each(["preparation", "supervisor"] as const)(
    "preserves abort identity after %s without starting health probes",
    async (stage) => {
      const service = makeGatewayService({ status: "stopped" });
      const controller = new AbortController();
      const reason = new Error("original restart cancellation");
      if (stage === "preparation") {
        readBestEffortConfig.mockImplementation(async () => {
          controller.abort(reason);
          return {};
        });
      } else {
        vi.mocked(service.isLoaded).mockImplementation(async () => {
          controller.abort(reason);
          throw new Error("native inspection also failed");
        });
      }
      await expect(
        waitForGatewayHealthyRestart({ service, port: 18789, signal: controller.signal }),
      ).rejects.toBe(reason);
      expect(service.isLoaded).toHaveBeenCalledTimes(stage === "supervisor" ? 1 : 0);
      expect(service.readRuntime).not.toHaveBeenCalled();
      expect(inspectPortUsage).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it("does not start a native probe with less than one millisecond remaining", async () => {
    const service = makeGatewayService({ status: "stopped" });
    readBestEffortConfig.mockImplementation(async () => {
      monotonicClock.nowMs = 1999.5;
      return {};
    });
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      timeoutMs: 2000,
    });
    expect(snapshot).toMatchObject({ healthy: false, waitOutcome: "timeout" });
    expect(service.isLoaded).not.toHaveBeenCalled();
  });

  it.each(["live", "unknown"] as const)(
    "keeps positive owner death authoritative after observing %s with loaded supervision",
    async (initialState) => {
      const service = makeGatewayService({ status: "stopped" });
      vi.mocked(service.isLoaded).mockResolvedValue(true);
      readGatewayOwnerLease.mockImplementation(() => ({
        owner: "current-gateway-owner",
        pid: 4300,
        host: "gateway-test-host",
        startedAt: 1000,
        port: 18789,
        mode: "supervised",
        supervisor: { kind: "launchd", name: "ai.openclaw.gateway" },
        state: monotonicClock.nowMs === 0 ? initialState : "dead",
        expired: false,
      }));
      const snapshot = await waitForGatewayHealthyRestart({ service, port: 18789 });
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "stopped-free",
        elapsedMs: 500,
      });
      expect(service.isLoaded).toHaveBeenCalledOnce();
      expect(sleep).toHaveBeenCalledOnce();
    },
  );
});
