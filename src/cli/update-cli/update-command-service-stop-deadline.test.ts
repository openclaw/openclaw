// Install maintained service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import { startSystemdService, stopSystemdService } from "../../daemon/systemd-lifecycle.js";
import * as systemdScope from "../../daemon/systemd-scope.js";
import * as systemdTransport from "../../daemon/systemd-user-transport.js";
import * as portInspection from "../../infra/ports-inspect.js";
import { createDoctorServiceInspectionBudget } from "../../infra/update-doctor-deadline.js";
import * as updateGitRuntime from "../../infra/update-git-runtime.js";
import * as processExec from "../../process/exec.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
const { fixtureGatewayPid, mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

const deadlineAtMs = 1_500;

async function nativeStopFixture(
  home: string,
  expireDuring: "transport" | "settlement",
  wallCorrection = -90_000,
) {
  mockProcessPlatform("linux");
  let wallNow = 1_000;
  let elapsedMs = 0;
  let preparingNativeStop = false;
  const transportPhases: string[] = [];
  const expireDeadline = () => {
    wallNow += wallCorrection;
    elapsedMs = 501;
  };
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  // Exercise predecessor discovery even without dist/build-info.json. Its read-only
  // listener probe must not borrow the expiry fault reserved for the native stop.
  vi.spyOn(updateGitRuntime, "readBuiltGatewayBuildId").mockResolvedValue("deadline-fixture");
  const inspectPort = vi
    .spyOn(portInspection, "inspectPortUsage")
    .mockImplementation(async (port) => ({
      port,
      status: "free",
      listeners: [],
      hints: [],
    }));
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockResolvedValue(null);
  vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue(undefined);
  vi.spyOn(systemdScope, "assertNoSystemGatewayOwnershipForActivation").mockResolvedValue(
    undefined,
  );
  vi.spyOn(systemdTransport, "resolveSystemdUserTransport").mockImplementation(async () => {
    transportPhases.push(preparingNativeStop ? "native-stop" : "inspection");
    // Discovery may also resolve transport; only the actual stop owns this fault.
    if (expireDuring === "transport" && preparingNativeStop) {
      expireDeadline();
    }
    return undefined;
  });
  const dispatch = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
    if (expireDuring === "transport") {
      throw new Error("Unexpected native dispatch after transport deadline");
    }
    expireDeadline();
    return { stdout: "", stderr: "", code: 0, termination: "exit", signal: null, killed: false };
  });
  const service = createMockGatewayService({
    readCommand: async () => ({
      programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
      environment: { HOME: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-stop-deadline" },
    }),
    readRuntime: async () => ({
      status: "running",
      pid: fixtureGatewayPid,
      systemd: { managerUid: 2001 },
    }),
    isLoaded: async () => true,
    stop: vi.fn(async (params) => {
      preparingNativeStop = true;
      try {
        await stopSystemdService(params);
      } finally {
        preparingNativeStop = false;
      }
    }),
  });
  mocks.service.mockReturnValue(service);
  const expectedService = await maybeStopManagedServiceBeforeMutableUpdate({
    root: process.cwd(),
    updateInstallKind: "package",
    shouldRestart: true,
    jsonMode: true,
    phase: "inspect",
  });
  const remaining = createDoctorServiceInspectionBudget(deadlineAtMs);
  return {
    service,
    dispatch,
    expectedService,
    remaining,
    expireDeadline,
    transportPhases,
    inspectPort,
  };
}

it.each([-90_000, 90_000])(
  "refuses the Doctor native stop when transport preparation consumes the deadline (wall correction %s)",
  (wallCorrection) =>
    withServiceHome(async (home) => {
      const { service, dispatch, transportPhases, inspectPort } = await nativeStopFixture(
        home,
        "transport",
        wallCorrection,
      );
      vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockImplementation(async () => {
        // A preceding read must not consume the fault intended for native stop preparation.
        await systemdTransport.resolveSystemdUserTransport(process.env);
        return true;
      });
      await expect(
        beginDoctorMaintenance({
          root: process.cwd(),
          options: { repair: true },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          serviceInspectionDeadlineAtMs: deadlineAtMs,
        }),
      ).rejects.toThrow("Doctor service-inspection deadline has expired.");
      expect(inspectPort).toHaveBeenCalledOnce();
      expect(inspectPort).toHaveBeenCalledWith(18789, expect.any(Object));
      expect(service.stop).toHaveBeenCalledOnce();
      expect(transportPhases).toContain("inspection");
      expect(transportPhases).toContain("native-stop");
      expect(dispatch).not.toHaveBeenCalled();
    }),
);

it("refuses an already-expired Doctor deadline before entering native stop", () =>
  withServiceHome(async (home) => {
    const { service, dispatch, expireDeadline, transportPhases } = await nativeStopFixture(
      home,
      "transport",
    );
    vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockImplementation(async () => {
      expireDeadline();
      return true;
    });
    await expect(
      beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        serviceInspectionDeadlineAtMs: deadlineAtMs,
      }),
    ).rejects.toThrow("Doctor service-inspection deadline has expired.");
    expect(service.stop).not.toHaveBeenCalled();
    expect(transportPhases).not.toContain("native-stop");
    expect(dispatch).not.toHaveBeenCalled();
  }));

it("retains the stop receipt and native restoration after an admitted stop crosses expiry", () =>
  withServiceHome(async (home) => {
    const { dispatch, expectedService, remaining } = await nativeStopFixture(home, "settlement");
    const onStopped = vi.fn();
    const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      jsonMode: true,
      expectedService,
      onStopped,
      assertDeadline: remaining,
    });
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      "systemctl",
      "--user",
      "stop",
      "openclaw-stop-deadline.service",
    ]);
    expect(stopped?.stopped).toBe(true);
    expect(onStopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stopped: true }));
    const assertCurrent = vi.fn();
    await startSystemdService({
      env: stopped?.serviceEnv,
      stdout: new PassThrough(),
      assertCurrent,
    });
    expect(assertCurrent).toHaveBeenCalled();
    expect(dispatch.mock.calls.map(([argv]) => argv)).toEqual([
      ["systemctl", "--user", "stop", "openclaw-stop-deadline.service"],
      ["systemctl", "--user", "reset-failed", "openclaw-stop-deadline.service"],
      ["systemctl", "--user", "start", "openclaw-stop-deadline.service"],
    ]);
  }));
