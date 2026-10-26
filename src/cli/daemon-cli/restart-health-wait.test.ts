// Managed gateway restart polling tests.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execLaunchctl } from "../../daemon/launchd-exec.js";
import { readLaunchAgentRuntime } from "../../daemon/launchd-runtime.js";
import { resolveLaunchAgentPlistPath } from "../../daemon/launchd-service-files.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  inspectPortUsage,
  createStartupMigrationActivityProbe,
  makeGatewayService,
  monotonicClock,
  callGateway,
  readGatewayOwnerLease,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
  waitForStoppedFreeGatewayRestart,
  waitForRunningGateway,
  portUsage,
  ownerLease,
} from "./restart-health.test-helpers.js";

vi.mock("../../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { renderRestartDiagnostics, formatGatewayRestartFailure } =
  await import("./restart-health.js");
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value, configurable: true });
const serveHealth = (server?: Parameters<typeof gatewayHealthResponse>[0]) =>
  callGateway.mockImplementation(gatewayHealthResponse(server));
const listenAfter = (time: number, pid = 8000) =>
  inspectPortUsage.mockImplementation(async () =>
    portUsage(monotonicClock.nowMs < time ? [] : [{ pid }]),
  );
function expectWait(
  snapshot: Awaited<ReturnType<typeof waitForRunningGateway>>,
  waitOutcome: Awaited<ReturnType<typeof waitForRunningGateway>>["waitOutcome"],
  elapsedMs: number,
) {
  expect(snapshot).toMatchObject({ healthy: waitOutcome === "healthy", waitOutcome, elapsedMs });
}

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it("uses the Windows cold-start allowance for Doctor restoration without a caller budget", async () => {
    setPlatform("win32");
    listenAfter(90_000);
    serveHealth();

    const result = await waitForRunningGateway({ requireRunningService: true });

    expect(result).toMatchObject({
      healthy: true,
      outcome: "ready",
      elapsedMs: 90_000,
    });
  });

  it("ends readiness polling immediately for a verified service hold", async () => {
    const runtime = {
      status: "unknown",
      systemd: {
        startRefusal: {
          reason: "refuse-manual-start" as const,
          message: "Resolve the managed service hold before starting.",
        },
      },
    };
    const service = makeGatewayService({ status: "stopped" });
    vi.mocked(service.readRuntime).mockResolvedValue(runtime);
    const result = await waitForRunningGateway({
      service,
      timeoutMs: 30 * 60_000,
      requireRunningService: true,
    });
    expect(result).toMatchObject({
      outcome: "failed",
      healthy: false,
      waitOutcome: "service-definition-refused",
      runtime,
      elapsedMs: 0,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(renderRestartDiagnostics(result)).toContain(
      "SERVICE-DEFINITION: Resolve the managed service hold before starting.",
    );
    expect(
      formatGatewayRestartFailure({
        health: result,
        port: 18789,
        defaultTimeoutSeconds: 30 * 60,
      }),
    ).toMatchObject({
      failMessage: "SERVICE-DEFINITION: Resolve the managed service hold before starting.",
    });
  });

  it("waits for a recorded live owner with an expired lease before it listens", async () => {
    setPlatform("win32");
    readGatewayOwnerLease.mockReturnValue({ ...ownerLease(2080), expired: true });
    listenAfter(100_000, 2080);
    serveHealth();

    const snapshot = await waitForRunningGateway({
      service: makeGatewayService({ status: "stopped" }),
      attempts: 360,
      delayMs: 500,
    });
    expectWait(snapshot, "healthy", 100_000);
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("waits past a previous dead owner until its replacement publishes ownership and becomes ready", async () => {
    setPlatform("win32");
    readGatewayOwnerLease.mockImplementation(() => {
      const replacement = monotonicClock.nowMs >= 1000;
      return ownerLease(
        replacement ? 2080 : 6464,
        replacement ? "live" : "dead",
        replacement ? 2000 : 1000,
      );
    });
    listenAfter(2000, 2080);
    serveHealth();
    const snapshot = await waitForRunningGateway({
      service: makeGatewayService({ status: "stopped" }),
      attempts: 20,
      delayMs: 500,
    });
    expectWait(snapshot, "healthy", 2000);
  });

  it("returns as soon as an owner observed unknown in this wait dies with the port free", async () => {
    readGatewayOwnerLease.mockImplementation(() => ({
      ...ownerLease(2080),
      state: monotonicClock.nowMs === 0 ? "unknown" : "dead",
    }));
    const snapshot = await waitForStoppedFreeGatewayRestart();
    expectWait(snapshot, "stopped-free", 500);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "does not reset the bound when a listener appears",
      boundAtMs: 150_000,
      elapsedMs: 300_000,
      phase: "waiting for Gateway health and identity",
    },
    {
      name: "requires observed startup progress",
      running: false,
      elapsedMs: 60_000,
    },
  ])("$name", async ({ boundAtMs, running, elapsedMs, phase }) => {
    callGateway.mockRejectedValue(new Error("Gateway health timed out"));
    inspectPortUsage.mockImplementation(async (port) =>
      portUsage(monotonicClock.nowMs < (boundAtMs ?? Infinity) ? [] : [{ pid: 8000 }], { port }),
    );
    const service = makeGatewayService({ status: "running", pid: 8000 });
    if (running === false) {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "unknown" });
    }
    const snapshot = await waitForRunningGateway({
      service,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      expectedVersion: boundAtMs === undefined ? undefined : "2026.9.4",
    });
    expectWait(snapshot, "timeout", elapsedMs);
    expect(renderRestartDiagnostics(snapshot)).toContain(
      `Readiness budget exhausted after ${elapsedMs / 1000}s. Last observed startup phase: ${phase ?? "waiting for managed service"}.`,
    );
  });

  it.each([
    ["linux", 3, "timeout", 1_000],
    ["win32", 1, "healthy", 0],
  ] as const)(
    "handles missing runtime PID on %s",
    async (platform, healthProbeCount, outcome, elapsedMs) => {
      setPlatform(platform);
      const service = makeGatewayService({ status: "running", pid: 8000 });
      for (let probe = 0; probe < healthProbeCount; probe += 1) {
        vi.mocked(service.readRuntime).mockResolvedValueOnce({ status: "running", pid: undefined });
        callGateway.mockImplementationOnce(
          gatewayHealthResponse({ server: { version: "2026.8.1" } }),
        );
      }
      inspectPortUsage.mockResolvedValue(portUsage([{ pid: 8000 }, { pid: 9000 }]));

      const snapshot = await waitForRunningGateway({
        service,
        expectedVersion: "2026.8.1",
        requireRunningService: true,
        attempts: 2,
        delayMs: 500,
      });

      expectWait(snapshot, outcome, elapsedMs);
      expect(snapshot.runtime.pid).toBeUndefined();
      expect(callGateway).toHaveBeenCalledTimes(healthProbeCount);
    },
  );

  it("accepts the selected LaunchAgent after its temporarily unloaded job returns", async () => {
    setPlatform("darwin");
    const env = {
      HOME: tempDirs.make("openclaw-launchd-settle-"),
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.settle-fixture",
    };
    const plistPath = resolveLaunchAgentPlistPath(env);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, "<plist/>");
    const target = `gui/${process.getuid?.() ?? 501}/${env.OPENCLAW_LAUNCHD_LABEL}`;
    vi.mocked(execLaunchctl).mockImplementation(async (args) => {
      expect(args[0]).toBe("print");
      expect([target, `system/${env.OPENCLAW_LAUNCHD_LABEL}`]).toContain(args[1]);
      if (args[1] !== target || monotonicClock.nowMs === 0) {
        return { code: 113, stdout: "", stderr: "Could not find service", termination: "exit" };
      }
      return {
        code: 0,
        stderr: "",
        termination: "exit",
        stdout: [
          `${target} = {`,
          "\tstate = running",
          "\tpid = 8000",
          "\tresource coalition = {",
          "\t\tstate = active",
          "\t}",
          "\tjetsam coalition = {",
          "\t\tstate = active",
          "\t}",
          "}",
        ].join("\n"),
      };
    });
    serveHealth({ server: { version: "2026.4.24", connId: "new" } });
    inspectPortUsage.mockResolvedValue(portUsage([{ pid: 8000, commandLine: "openclaw-gateway" }]));
    const snapshot = await waitForRunningGateway({
      service: { readRuntime: readLaunchAgentRuntime, readCommand: async () => null },
      env,
      expectedVersion: "2026.4.24",
      requireRunningService: true,
      attempts: 3,
      delayMs: 1,
    });

    expect(snapshot).toMatchObject({
      healthy: true,
      runtime: { status: "running", pid: 8000 },
      waitOutcome: "healthy",
      elapsedMs: 1,
    });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("keeps the readiness window after an observed migration ends near the standard deadline", async () => {
    serveHealth();
    let inspections = 0;
    inspectPortUsage.mockImplementation(async () =>
      portUsage(++inspections < 8 ? [] : [{ pid: 8000, commandLine: "openclaw-gateway" }]),
    );
    let migrationPolls = 0;
    const snapshot = await waitForRunningGateway({
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive: createStartupMigrationActivityProbe(() => ++migrationPolls < 7),
    });
    expectWait(snapshot, "healthy", 70_000);
    expect(sleep).toHaveBeenCalledTimes(7);
  });

  it("bounds an explicit readiness budget without migration", async () => {
    const snapshot = await waitForRunningGateway({
      timeoutMs: 120_000,
      isStartupMigrationActive: () => false,
    });
    expectWait(snapshot, "still-starting", 120_000);
    expect(renderRestartDiagnostics(snapshot)).toContain(
      "Gateway service is still starting after 120s. Last observed startup phase: waiting for Gateway listener. Run openclaw gateway status --deep.",
    );
  });

  it("accepts a launchd KeepAlive restart after the stopped-free grace window", async () => {
    let runtimeReads = 0;
    let portInspections = 0;
    const service = makeGatewayService({ status: "stopped" });
    vi.mocked(service.readRuntime).mockImplementation(async () =>
      ++runtimeReads >= 27 ? { status: "running", pid: 8000 } : { status: "stopped" },
    );
    inspectPortUsage.mockImplementation(async () =>
      portUsage(++portInspections >= 27 ? [{ pid: 8000, commandLine: "openclaw-gateway" }] : []),
    );
    serveHealth();

    const snapshot = await waitForRunningGateway({
      service,
      attempts: 120,
      delayMs: 500,
      supervisorKeepsAlive: true,
    });

    expectWait(snapshot, "healthy", 13_000);
  });

  it("waits longer before stopped-free early exit on Windows", async () => {
    setPlatform("win32");

    const snapshot = await waitForStoppedFreeGatewayRestart();

    expect(snapshot.runtime.status).toBe("stopped");
    expect(snapshot.portUsage.status).toBe("free");
    expectWait(snapshot, "stopped-free", 92_500);
    expect(sleep).toHaveBeenCalledTimes(185);
  });

  it("fails immediately when a reachable gateway omits build identity", async () => {
    inspectPortUsage.mockResolvedValue(portUsage([{ pid: 8000, commandLine: "openclaw-gateway" }]));
    serveHealth({ server: { version: "2026.4.26", connId: "legacy" } });

    const snapshot = await waitForRunningGateway({
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });

    expectWait(snapshot, "build-id-mismatch", 0);
    expect(snapshot.buildIdMismatch).toEqual({ expected: "new-build", actual: null });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("cancels a migration-extended wait before another health inspection", async () => {
    const controller = new AbortController();
    const aborted = new Error("repair-budget");
    inspectPortUsage.mockResolvedValue(portUsage());
    sleep.mockImplementationOnce(async () => {
      controller.abort(aborted);
    });
    await expect(
      waitForRunningGateway({
        attempts: 1,
        delayMs: 60_000,
        isStartupMigrationActive: () => true,
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
    expect(inspectPortUsage).toHaveBeenCalledOnce();
  });
});
