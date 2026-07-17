// Managed gateway restart polling tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS } from "../../daemon/launchd-plist.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  inspectPortUsage,
  makeGatewayService,
  monotonicClock,
  probeGateway,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
  waitForStoppedFreeGatewayRestart,
} from "./restart-health.test-helpers.js";

/** Expected stopped-free early-exit elapsed for KeepAlive using the product throttle. */
function keepAliveStoppedFreeElapsedMs(delayMs: number): number {
  const throttleMs = LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS * 1000;
  const throttlePolls = Math.ceil(throttleMs / Math.max(1, delayMs));
  const threshold = Math.max(6, throttlePolls + 2);
  // Grace is 10s on non-Windows; consecutive counting starts at that attempt index.
  const minAttemptForEarlyExit = Math.ceil(10_000 / delayMs);
  const finalAttempt = minAttemptForEarlyExit + threshold - 1;
  return finalAttempt * delayMs;
}

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it("waits for the managed service when running service proof is required", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "new" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    const readRuntime = vi
      .fn()
      .mockResolvedValueOnce({ status: "stopped" })
      .mockResolvedValue({ status: "running", pid: 8000 });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: { readRuntime } as unknown as GatewayService,
      port: 18789,
      expectedVersion: "2026.4.24",
      requireRunningService: true,
      attempts: 3,
      delayMs: 1,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.runtime.status).toBe("running");
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(1);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("times out when running service proof never arrives", async () => {
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.24", connId: "stale" },
    });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 5151, commandLine: "openclaw-gateway" }],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "stopped" }),
      port: 18789,
      expectedVersion: "2026.4.24",
      requireRunningService: true,
      attempts: 2,
      delayMs: 1,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("waits through a healthy long-running startup migration", async () => {
    let inspections = 0;
    inspectPortUsage.mockImplementation(async () => {
      inspections += 1;
      if (inspections < 15) {
        return {
          port: 18789,
          status: "free",
          listeners: [],
          hints: [],
        };
      }
      return {
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      };
    });
    const isStartupMigrationActive = vi.fn(() => true);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(140_000);
    expect(sleep).toHaveBeenCalledTimes(14);
    expect(isStartupMigrationActive).toHaveBeenCalled();
  });

  it("keeps the readiness window after an observed migration ends near the standard deadline", async () => {
    let inspections = 0;
    inspectPortUsage.mockImplementation(async () => {
      inspections += 1;
      return inspections < 8
        ? { port: 18789, status: "free", listeners: [], hints: [] }
        : {
            port: 18789,
            status: "busy",
            listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
            hints: [],
          };
    });
    let migrationPolls = 0;
    const isStartupMigrationActive = vi.fn(() => {
      migrationPolls += 1;
      return migrationPolls < 7;
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(70_000);
    expect(sleep).toHaveBeenCalledTimes(7);
  });

  it("keeps the caller's full readiness window after an observed migration ends", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    let migrationPolls = 0;
    const isStartupMigrationActive = vi.fn(() => {
      migrationPolls += 1;
      return migrationPolls < 4;
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 18,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(210_000);
    expect(sleep).toHaveBeenCalledTimes(21);
  });

  it("keeps the standard timeout for a running non-migration startup failure", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const isStartupMigrationActive = vi.fn(() => false);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(60_000);
    expect(sleep).toHaveBeenCalledTimes(6);
    expect(isStartupMigrationActive).toHaveBeenCalledTimes(7);
  });

  it("bounds a startup migration that never reaches readiness", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const isStartupMigrationActive = vi.fn(() => true);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 1,
      delayMs: 60_000,
      isStartupMigrationActive,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(300_000);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it("includes slow health inspections in the migration watchdog", async () => {
    inspectPortUsage.mockImplementation(async () => {
      monotonicClock.nowMs += 90_000;
      return {
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      };
    });
    const isStartupMigrationActive = vi.fn(() => true);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      attempts: 1,
      delayMs: 10_000,
      isStartupMigrationActive,
    });

    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(390_000);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("annotates stopped-free early exits with the actual elapsed time", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("stopped-free");
    expect(snapshot.elapsedMs).toBe(12_500);
    expect(sleep).toHaveBeenCalledTimes(25);
  });

  it("waits longer before stopped-free early exit on Windows", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("stopped-free");
    expect(snapshot.elapsedMs).toBe(92_500);
    expect(sleep).toHaveBeenCalledTimes(185);
  });

  it("extends stopped-free early exit for a loaded launchd KeepAlive service", async () => {
    // KeepAlive + product ThrottleInterval can leave stopped+port-free for a full
    // throttle window; baseline after the 10s grace false-fires (#109941).
    // Expected elapsed is derived from LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS so
    // this stays aligned with the launchd product default (currently 10s on main).
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });

    const isLoaded = vi.fn(async () => true);
    const service = {
      ...makeGatewayService({ status: "stopped" }),
      isLoaded,
    } as GatewayService;
    const serviceEnv = { OPENCLAW_PROFILE: "keepalive-test" } as NodeJS.ProcessEnv;
    const delayMs = 500;
    const expectedElapsedMs = keepAliveStoppedFreeElapsedMs(delayMs);

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 120,
      delayMs,
      env: serviceEnv,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("stopped-free");
    expect(LAUNCH_AGENT_THROTTLE_INTERVAL_SECONDS).toBe(10);
    expect(snapshot.elapsedMs).toBe(expectedElapsedMs);
    expect(expectedElapsedMs).toBe(20_500);
    expect(sleep).toHaveBeenCalledTimes(expectedElapsedMs / delayMs);
    expect(isLoaded).toHaveBeenCalledOnce();
    expect(isLoaded).toHaveBeenCalledWith({ env: serviceEnv });
  });

  it.each([
    ["unloaded", vi.fn(async () => false)],
    [
      "unavailable",
      vi.fn(async () => {
        throw new Error("launchctl unavailable");
      }),
    ],
  ])("keeps baseline stopped-free exit when launchd is %s", async (_name, isLoaded) => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    const service = {
      ...makeGatewayService({ status: "stopped" }),
      isLoaded,
    } as GatewayService;

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 120,
      delayMs: 500,
    });

    expect(snapshot.waitOutcome).toBe("stopped-free");
    expect(snapshot.elapsedMs).toBe(12_500);
    expect(sleep).toHaveBeenCalledTimes(25);
    expect(isLoaded).toHaveBeenCalledOnce();
  });

  it("does not stop-free-exit inside one KeepAlive throttle window when health recovers", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    let inspectCount = 0;
    inspectPortUsage.mockImplementation(async () => {
      inspectCount += 1;
      // Stay free longer than the baseline false-exit window (~26 inspects / 12.5s),
      // then bind so health can succeed — proves KeepAlive extension is required.
      if (inspectCount < 28) {
        return { port: 18789, status: "free" as const, listeners: [], hints: [] };
      }
      return {
        port: 18789,
        status: "busy" as const,
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      };
    });
    const readRuntime = vi.fn(async () =>
      inspectCount < 28
        ? { status: "stopped" as const }
        : { status: "running" as const, pid: 8000 },
    );
    const isLoaded = vi.fn(async () => true);
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.7.1", connId: "new" },
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service: { readRuntime, isLoaded } as unknown as GatewayService,
      port: 18789,
      attempts: 120,
      delayMs: 500,
    });

    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.healthy).toBe(true);
    expect(snapshot.elapsedMs).toBeGreaterThan(12_500);
    expect(isLoaded).toHaveBeenCalledOnce();
  });

  it("keeps waiting when the expected gateway version is not available yet", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage
      .mockResolvedValueOnce({
        port: 18789,
        status: "free",
        listeners: [],
        hints: [],
      })
      .mockResolvedValueOnce({
        port: 18789,
        status: "busy",
        listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
        hints: [],
      });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.4.26", connId: "new" },
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedVersion: "2026.4.26",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.gatewayVersion).toBe("2026.4.26");
    expect(snapshot.expectedVersion).toBe("2026.4.26");
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(1_000);
    expect(snapshot.versionMismatch).toBeUndefined();
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("annotates timeout waits when the health loop exhausts all attempts", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });

    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.runtime.status).toBe("running");
    expect(snapshot.runtime.pid).toBe(8000);
    expect(snapshot.portUsage.status).toBe("free");
    expect(snapshot.waitOutcome).toBe("timeout");
    expect(snapshot.elapsedMs).toBe(4_000);
    expect(sleep).toHaveBeenCalledTimes(4);
  });
});
