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
import * as ports from "../../infra/ports-inspect.js";
import { createDoctorServiceInspectionBudget } from "../../infra/update-doctor-deadline.js";
import * as processExec from "../../process/exec.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
const { fixtureGatewayPid, mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

const deadlineAtMs = 1_500;

async function nativeStopFixture(home: string, expireDuring: "transport" | "settlement") {
  mockProcessPlatform("linux");
  let wallNow = 1_000;
  let elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  vi.spyOn(ports, "inspectPortUsage").mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });
  vi.spyOn(systemdScope, "findInstalledSystemdGatewayScope").mockResolvedValue(null);
  vi.spyOn(systemdExec, "assertSystemdAvailable").mockResolvedValue(undefined);
  vi.spyOn(systemdScope, "assertNoSystemGatewayOwnershipForActivation").mockResolvedValue(
    undefined,
  );
  vi.spyOn(systemdTransport, "resolveSystemdUserTransport").mockImplementation(async () => {
    if (expireDuring === "transport") {
      wallNow -= 90_000;
      elapsedMs = 501;
    }
    return undefined;
  });
  const dispatch = vi.spyOn(processExec, "runCommandWithTimeout").mockImplementation(async () => {
    wallNow -= 90_000;
    elapsedMs = 501;
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
    stop: vi.fn(stopSystemdService),
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
  return { service, dispatch, expectedService, remaining };
}

it("refuses the Doctor native stop when transport preparation consumes the deadline", () =>
  withServiceHome(async (home) => {
    const { service, dispatch } = await nativeStopFixture(home, "transport");
    vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
    await expect(
      beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        serviceInspectionDeadlineAtMs: deadlineAtMs,
      }),
    ).rejects.toThrow("Doctor service-inspection deadline has expired.");
    expect(service.stop).toHaveBeenCalledOnce();
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
