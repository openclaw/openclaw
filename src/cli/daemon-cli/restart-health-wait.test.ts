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
} from "./restart-health.test-helpers.js";

vi.mock("../../daemon/launchd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/launchd-exec.js")>()),
  execLaunchctl: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { waitForGatewayHealthyRestart, renderRestartDiagnostics, formatGatewayRestartFailure } =
  await import("./restart-health.js");

function ownerLease(overrides: Partial<NonNullable<ReturnType<typeof readGatewayOwnerLease>>>) {
  return {
    owner: "slow-gateway-owner",
    pid: 2080,
    host: "gateway-test-host",
    startedAt: 1000,
    port: 18789,
    mode: "supervised" as const,
    supervisor: { kind: "schtasks" as const, name: "OpenClaw Gateway" },
    state: "live" as const,
    expired: false,
    ...overrides,
  };
}

function portUsage(
  listeners: Awaited<ReturnType<typeof inspectPortUsage>>["listeners"] = [],
  port = 18789,
) {
  return {
    port,
    status: listeners.length ? ("busy" as const) : ("free" as const),
    listeners,
    hints: [],
  };
}

function waitForRestart(
  options: Partial<Omit<Parameters<typeof waitForGatewayHealthyRestart>[0], "child">> = {},
) {
  return waitForGatewayHealthyRestart({
    service: makeGatewayService({ status: "running", pid: 8000 }),
    port: 18789,
    ...options,
  });
}

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

const gatewayListener = { pid: 8000, commandLine: "openclaw-gateway" };

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

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
    const result = await waitForRestart({
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
      formatGatewayRestartFailure({ health: result, port: 18789, defaultTimeoutSeconds: 30 * 60 }),
    ).toMatchObject({
      failMessage: "SERVICE-DEFINITION: Resolve the managed service hold before starting.",
    });
  });

  it.each([
    ["an expired live owner", 100_000, 360, () => ownerLease({ expired: true })],
    [
      "a dead owner's replacement",
      2000,
      20,
      () => {
        const replacement = monotonicClock.nowMs >= 1000;
        return ownerLease({
          owner: replacement ? "replacement-gateway-owner" : "previous-gateway-owner",
          pid: replacement ? 2080 : 6464,
          startedAt: replacement ? 2000 : 1000,
          state: replacement ? "live" : "dead",
          expired: !replacement,
        });
      },
    ],
  ] as const)("waits for %s to listen", async (_name, elapsedMs, attempts, lease) => {
    setPlatform("win32");
    readGatewayOwnerLease.mockImplementation(lease);
    inspectPortUsage.mockImplementation(async () =>
      portUsage(monotonicClock.nowMs < elapsedMs ? [] : [{ pid: 2080 }]),
    );
    callGateway.mockImplementation(gatewayHealthResponse());
    const snapshot = await waitForRestart({
      service: makeGatewayService({ status: "stopped" }),
      attempts,
      delayMs: 500,
    });
    expect(snapshot, snapshot.probeError).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      elapsedMs,
    });
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("returns as soon as an owner observed unknown in this wait dies with the port free", async () => {
    readGatewayOwnerLease.mockImplementation(() =>
      ownerLease({
        owner: "exited-gateway-owner",
        state: monotonicClock.nowMs === 0 ? "unknown" : "dead",
      }),
    );
    const snapshot = await waitForStoppedFreeGatewayRestart();
    expect(snapshot).toMatchObject({ healthy: false, waitOutcome: "stopped-free", elapsedMs: 500 });
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each([
    [150_000, true, 300_000, "waiting for Gateway health and identity"],
    [Infinity, false, 60_000, "waiting for managed service"],
  ] as const)(
    "bounds update readiness with listener at %sms (running: %s)",
    async (boundAtMs, running, elapsedMs, phase) => {
      callGateway.mockRejectedValue(new Error("Gateway health timed out"));
      inspectPortUsage.mockImplementation(async (port) =>
        portUsage(monotonicClock.nowMs < boundAtMs ? [] : [{ pid: 8000 }], port),
      );
      const service = makeGatewayService({ status: "running", pid: 8000 });
      if (running === false) {
        vi.mocked(service.readRuntime).mockResolvedValue({ status: "unknown" });
      }
      const snapshot = await waitForRestart({
        service,
        env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        expectedVersion: running ? "2026.9.4" : undefined,
      });
      expect(snapshot).toMatchObject({ waitOutcome: "timeout", healthy: false, elapsedMs });
      expect(renderRestartDiagnostics(snapshot)).toContain(
        `Readiness budget exhausted after ${elapsedMs / 1000}s. Last observed startup phase: ${phase}.`,
      );
    },
  );

  it.each([
    ["linux", 3, "timeout", 1_000],
    ["win32", 1, "healthy", 0],
  ] as const)("handles missing runtime PID on %s", async (platform, polls, outcome, elapsedMs) => {
    setPlatform(platform);
    const service = makeGatewayService({ status: "running", pid: 8000 });
    for (let poll = 0; poll < polls; poll++) {
      vi.mocked(service.readRuntime).mockResolvedValueOnce({ status: "running", pid: undefined });
      callGateway.mockImplementationOnce(
        gatewayHealthResponse({ server: { version: "2026.8.1" } }),
      );
    }
    inspectPortUsage.mockResolvedValue(portUsage([{ pid: 8000 }, { pid: 9000 }]));
    const snapshot = await waitForRestart({
      service,
      expectedVersion: "2026.8.1",
      requireRunningService: true,
      attempts: 2,
      delayMs: 500,
    });
    expect(snapshot).toMatchObject({
      waitOutcome: outcome,
      healthy: outcome === "healthy",
      runtime: { pid: undefined },
      elapsedMs,
    });
    expect(callGateway).toHaveBeenCalledTimes(polls);
  });

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
          ...["resource", "jetsam"].map(
            (name) => `\t${name} coalition = {\n\t\tstate = active\n\t}`,
          ),
          "}",
        ].join("\n"),
      };
    });
    callGateway.mockImplementation(
      gatewayHealthResponse({ server: { version: "2026.4.24", connId: "new" } }),
    );
    inspectPortUsage.mockResolvedValue(portUsage([gatewayListener]));
    const snapshot = await waitForRestart({
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
    callGateway.mockImplementation(gatewayHealthResponse());
    let inspections = 0;
    inspectPortUsage.mockImplementation(async () =>
      portUsage(++inspections < 8 ? [] : [gatewayListener]),
    );
    let migrationPolls = 0;
    const snapshot = await waitForRestart({
      attempts: 6,
      delayMs: 10_000,
      isStartupMigrationActive: createStartupMigrationActivityProbe(() => ++migrationPolls < 7),
    });
    expect(snapshot).toMatchObject({ waitOutcome: "healthy", elapsedMs: 70_000 });
    expect(sleep).toHaveBeenCalledTimes(7);
  });

  it("bounds an explicit readiness budget without migration", async () => {
    const snapshot = await waitForRestart({
      timeoutMs: 120_000,
      isStartupMigrationActive: () => false,
    });
    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "still-starting",
      elapsedMs: 120_000,
    });
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
      portUsage(++portInspections >= 27 ? [gatewayListener] : []),
    );
    callGateway.mockImplementation(gatewayHealthResponse({}));
    const snapshot = await waitForRestart({
      service,
      attempts: 120,
      delayMs: 500,
      supervisorKeepsAlive: true,
    });
    expect(snapshot).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 13_000 });
  });

  it("waits longer before stopped-free early exit on Windows", async () => {
    setPlatform("win32");
    const snapshot = await waitForStoppedFreeGatewayRestart();
    expect(snapshot).toMatchObject({
      healthy: false,
      runtime: { status: "stopped" },
      portUsage: { status: "free" },
      waitOutcome: "stopped-free",
      elapsedMs: 92_500,
    });
    expect(sleep).toHaveBeenCalledTimes(185);
  });

  it("fails immediately when a reachable gateway omits build identity", async () => {
    inspectPortUsage.mockResolvedValue(portUsage([gatewayListener]));
    callGateway.mockImplementation(
      gatewayHealthResponse({ server: { version: "2026.4.26", connId: "legacy" } }),
    );
    const snapshot = await waitForRestart({
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });
    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "build-id-mismatch",
      elapsedMs: 0,
    });
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
      waitForRestart({
        attempts: 1,
        delayMs: 60_000,
        isStartupMigrationActive: () => true,
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
    expect(inspectPortUsage).toHaveBeenCalledOnce();
  });
});
