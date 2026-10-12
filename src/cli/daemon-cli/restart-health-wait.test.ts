// Managed gateway restart polling tests.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execLaunchctl } from "../../daemon/launchd-exec.js";
import { readLaunchAgentRuntime } from "../../daemon/launchd-runtime.js";
import { resolveLaunchAgentPlistPath } from "../../daemon/launchd-service-files.js";
import type { GatewayService } from "../../daemon/service.js";
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

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each(["refuse-manual-start"] as const)(
    "ends readiness polling immediately for a verified service hold (%s)",
    async (reason) => {
      const runtime = {
        status: "unknown",
        systemd: {
          startRefusal: { reason, message: "Resolve the managed service hold before starting." },
        },
      };
      const service = makeGatewayService({ status: "stopped" });
      vi.mocked(service.readRuntime).mockResolvedValue(runtime);
      const result = await waitForGatewayHealthyRestart({
        service,
        port: 18789,
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
    },
  );

  it.each([true])(
    "waits for a recorded live owner before it listens (expired=%s)",
    async (expired) => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      readGatewayOwnerLease.mockReturnValue({
        owner: "slow-gateway-owner",
        pid: 2080,
        host: "gateway-test-host",
        startedAt: 1000,
        port: 18789,
        mode: "supervised",
        supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
        state: "live",
        expired,
      });
      inspectPortUsage.mockImplementation(async () => ({
        port: 18789,
        status: monotonicClock.nowMs < 100_000 ? "free" : "busy",
        listeners: monotonicClock.nowMs < 100_000 ? [] : [{ pid: 2080 }],
        hints: [],
      }));
      callGateway.mockImplementation(gatewayHealthResponse());

      const snapshot = await waitForGatewayHealthyRestart({
        service: makeGatewayService({ status: "stopped" }),
        port: 18789,
        attempts: 360,
        delayMs: 500,
      });
      expect(snapshot, snapshot.probeError).toMatchObject({
        healthy: true,
        waitOutcome: "healthy",
        elapsedMs: 100_000,
      });
      expect(snapshot.staleGatewayPids).toEqual([]);
    },
  );

  it("waits past a previous dead owner until its replacement publishes ownership and becomes ready", async () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    readGatewayOwnerLease.mockImplementation(() => {
      const replacement = monotonicClock.nowMs >= 1000;
      return {
        owner: replacement ? "replacement-gateway-owner" : "previous-gateway-owner",
        pid: replacement ? 2080 : 6464,
        host: "gateway-test-host",
        startedAt: replacement ? 2000 : 1000,
        port: 18789,
        mode: "supervised",
        supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
        state: replacement ? "live" : "dead",
        expired: !replacement,
      };
    });
    inspectPortUsage.mockImplementation(async () => ({
      port: 18789,
      status: monotonicClock.nowMs < 2000 ? "free" : "busy",
      listeners: monotonicClock.nowMs < 2000 ? [] : [{ pid: 2080 }],
      hints: [],
    }));
    callGateway.mockImplementation(gatewayHealthResponse());
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "stopped" }),
      port: 18789,
      attempts: 20,
      delayMs: 500,
    });
    expect(snapshot).toMatchObject({ healthy: true, waitOutcome: "healthy", elapsedMs: 2000 });
  });

  it.each(["unknown"] as const)(
    "returns as soon as an owner observed %s in this wait dies with the port free",
    async (initialState) => {
      readGatewayOwnerLease.mockImplementation(() => ({
        owner: "exited-gateway-owner",
        pid: 2080,
        host: "gateway-test-host",
        startedAt: 1000,
        port: 18789,
        mode: "supervised",
        supervisor: { kind: "schtasks", name: "OpenClaw Gateway" },
        state: monotonicClock.nowMs === 0 ? initialState : "dead",
        expired: false,
      }));
      const snapshot = await waitForStoppedFreeGatewayRestart();
      expect(snapshot).toMatchObject({
        healthy: false,
        waitOutcome: "stopped-free",
        elapsedMs: 500,
      });
      expect(sleep).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "does not reset the bound when a listener appears",
      marker: "1",
      readyAtMs: Infinity,
      boundAtMs: 150_000,
      outcome: "timeout",
      elapsedMs: 300_000,
      phase: "waiting for Gateway health and identity",
    },
    {
      name: "requires observed startup progress",
      marker: "1",
      readyAtMs: Infinity,
      running: false,
      outcome: "timeout",
      elapsedMs: 60_000,
    },
  ])("$name", async ({ marker, readyAtMs, boundAtMs, running, outcome, elapsedMs, phase }) => {
    callGateway.mockImplementation(async (options) => {
      if (monotonicClock.nowMs < readyAtMs) {
        throw new Error("Gateway health timed out");
      }
      return gatewayHealthResponse()(options);
    });
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: monotonicClock.nowMs < (boundAtMs ?? readyAtMs) ? "free" : "busy",
      listeners: monotonicClock.nowMs < (boundAtMs ?? readyAtMs) ? [] : [{ pid: 8000 }],
      hints: [],
    }));
    const service = makeGatewayService({ status: "running", pid: 8000 });
    if (running === false) {
      vi.mocked(service.readRuntime).mockResolvedValue({ status: "unknown" });
    }
    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: marker },
      expectedVersion: boundAtMs === undefined ? undefined : "2026.9.4",
    });
    expect(snapshot.waitOutcome).toBe(outcome);
    expect(snapshot.healthy).toBe(outcome === "healthy");
    expect(snapshot.elapsedMs).toBe(elapsedMs);
    if (outcome === "timeout") {
      expect(renderRestartDiagnostics(snapshot)).toContain(
        `Readiness budget exhausted after ${elapsedMs / 1000}s. Last observed startup phase: ${phase ?? "waiting for managed service"}.`,
      );
    }
  });

  it.each([
    {
      name: "restarts settling after an unhealthy probe",
      pids: [8000, 8000, 8000, 8000, 8000, 8000],
      reachable: [true, true, false, true, true, true],
      attempts: 6,
      outcome: "healthy",
      elapsedMs: 2_500,
    },
    {
      name: "restarts settling when the healthy process changes",
      pids: [8000, 8000, 9000, 9000, 9000],
      reachable: [true, true, true, true, true],
      attempts: 6,
      outcome: "healthy",
      elapsedMs: 2_000,
    },
    {
      name: "restarts settling when the boot changes under the same PID",
      pids: [8000, 8000, 8000, 8000, 8000],
      bootIds: ["boot-a", "boot-a", "boot-b", "boot-b", "boot-b"],
      reachable: [true, true, true, true, true],
      attempts: 6,
      outcome: "healthy",
      elapsedMs: 2_000,
    },
    {
      name: "does not report an unsettled healthy snapshot as recovered at timeout",
      pids: [8000, 8000, 8000, 8000, 8000],
      bootIds: ["boot-a", "boot-a", "boot-a", "boot-a", "boot-a"],
      reachable: [false, false, false, true, true],
      attempts: 2,
      outcome: "timeout",
      elapsedMs: 2_000,
    },
    ...(["linux"] as const).map((platform) => ({
      name: `times out without a runtime PID on ${platform}`,
      platform,
      pids: [undefined, undefined, undefined, undefined, undefined],
      reachable: [true, true, true, true, true],
      attempts: 2,
      outcome: "timeout",
      elapsedMs: 2_000,
    })),
    {
      name: "settles without a runtime PID on win32",
      platform: "win32",
      pids: [undefined, undefined, undefined],
      reachable: [true, true, true],
      attempts: 2,
      outcome: "healthy",
      elapsedMs: 1_000,
    },
  ])("$name", async ({ platform, pids, bootIds, reachable, attempts, outcome, elapsedMs }) => {
    if (platform) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
    const service = makeGatewayService({ status: "running", pid: 8000 });
    for (const pid of pids) {
      vi.mocked(service.readRuntime).mockResolvedValueOnce({ status: "running", pid });
    }
    for (const [index, ok] of reachable.entries()) {
      if (ok) {
        callGateway.mockImplementationOnce(
          gatewayHealthResponse({
            server: { version: "2026.8.1", ...(bootIds ? { bootId: bootIds[index] } : {}) },
          }),
        );
      } else {
        callGateway.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
      }
    }
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000 }, { pid: 9000 }],
      hints: [],
    });

    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedVersion: "2026.8.1",
      requireRunningService: true,
      attempts,
      delayMs: 500,
      settle: { probes: 3 },
    });

    expect(snapshot.waitOutcome).toBe(outcome);
    expect(snapshot.healthy).toBe(outcome === "healthy");
    expect(snapshot.runtime.pid).toBe(pids.at(-1));
    expect(snapshot.elapsedMs).toBe(elapsedMs);
    expect(callGateway).toHaveBeenCalledTimes(reachable.length);
  });

  it("settles the selected LaunchAgent after its temporarily unloaded job returns", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
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
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.24", connId: "new" },
      }),
    );
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    const snapshot = await waitForGatewayHealthyRestart({
      service: { readRuntime: readLaunchAgentRuntime, readCommand: async () => null },
      env,
      port: 18789,
      expectedVersion: "2026.4.24",
      requireRunningService: true,
      attempts: 3,
      delayMs: 1,
      settle: { probes: 3 },
    });

    expect(snapshot).toMatchObject({
      healthy: true,
      runtime: { status: "running", pid: 8000 },
      waitOutcome: "healthy",
      elapsedMs: 3,
    });
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("keeps the readiness window after an observed migration ends near the standard deadline", async () => {
    callGateway.mockImplementation(gatewayHealthResponse());
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
    const isStartupMigrationActive = createStartupMigrationActivityProbe(() => {
      migrationPolls += 1;
      return migrationPolls < 7;
    });

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

  it.each([false])("bounds an explicit readiness budget (migration=%s)", async (migration) => {
    const snapshot = await waitForGatewayHealthyRestart({
      service: makeGatewayService({ status: "running", pid: 8000 }),
      port: 18789,
      timeoutMs: 120_000,
      isStartupMigrationActive: () => migration,
    });
    expect(snapshot).toMatchObject({
      healthy: false,
      waitOutcome: "still-starting",
      elapsedMs: 120_000,
    });
    expect(renderRestartDiagnostics(snapshot)).toContain(
      `Gateway service is still starting after 120s. Last observed startup phase: ${migration ? "startup migration" : "waiting for Gateway listener"}. Run openclaw gateway status --deep.`,
    );
  });

  it("accepts a launchd KeepAlive restart after the stopped-free grace window", async () => {
    let runtimeReads = 0;
    let portInspections = 0;
    const service = {
      readRuntime: vi.fn(async () =>
        ++runtimeReads >= 27 ? { status: "running", pid: 8000 } : { status: "stopped" },
      ),
      readCommand: vi.fn(async () => null),
    } as unknown as GatewayService;
    inspectPortUsage.mockImplementation(async () =>
      ++portInspections >= 27
        ? {
            port: 18789,
            status: "busy",
            listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
            hints: [],
          }
        : { port: 18789, status: "free", listeners: [], hints: [] },
    );
    callGateway.mockImplementation(gatewayHealthResponse({}));

    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      attempts: 120,
      delayMs: 500,
      supervisorKeepsAlive: true,
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.waitOutcome).toBe("healthy");
    expect(snapshot.elapsedMs).toBe(13_000);
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

  it("fails immediately when a reachable gateway omits build identity", async () => {
    const service = makeGatewayService({ status: "running", pid: 8000 });
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    callGateway.mockImplementation(
      gatewayHealthResponse({
        server: { version: "2026.4.26", connId: "legacy" },
      }),
    );

    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      expectedBuildId: "new-build",
      attempts: 4,
      delayMs: 1_000,
    });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.waitOutcome).toBe("build-id-mismatch");
    expect(snapshot.elapsedMs).toBe(0);
    expect(snapshot.buildIdMismatch).toEqual({ expected: "new-build", actual: null });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("cancels a migration-extended wait before another health inspection", async () => {
    const controller = new AbortController();
    const aborted = new Error("repair-budget");
    inspectPortUsage.mockResolvedValue({ port: 18789, status: "free", listeners: [], hints: [] });
    sleep.mockImplementationOnce(async () => {
      controller.abort(aborted);
    });
    await expect(
      waitForGatewayHealthyRestart({
        service: makeGatewayService({ status: "running", pid: 8000 }),
        port: 18789,
        attempts: 1,
        delayMs: 60_000,
        isStartupMigrationActive: () => true,
        signal: controller.signal,
      }),
    ).rejects.toBe(aborted);
    expect(inspectPortUsage).toHaveBeenCalledOnce();
  });
});
