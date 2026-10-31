import assert from "node:assert/strict";
// Install the native service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as doctorAdmission from "../../commands/doctor-maintenance-admission.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import {
  GatewayServiceStopUnsafeError,
  ServiceInspectionError,
  formatServiceInspectionReason,
} from "../../daemon/service-inspection-error.js";
import { readGatewayServiceState, type GatewayService } from "../../daemon/service.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { createDoctorServiceInspectionBudget } from "../../infra/update-doctor-deadline.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { createUpdateCommandFailureResult } from "./update-command-result.js";
import {
  gatewayCommand,
  maintenanceDefaults,
} from "./update-command-service-fixtures.test-support.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service-maintenance.js";
import {
  collectServiceInspectionFailureFacts,
  assertGatewayServiceAdmissionUnchanged,
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
} from "./update-command-service-plan.js";

const {
  mocks,
  nativeOfflineCases,
  withServiceHome,
  mockRegisteredWindowsLauncher,
  fixtureGatewayPid,
  mockMaintenanceService,
  expectNoServiceCalls,
} = await import("./update-command-service-maintenance.test-support.js");

it("preserves the shared service inspection deadline phase in recovery guidance", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockMaintenanceService(home, {
      isLoaded: async () => false,
      readRuntime: async () => ({ status: "stopped" }),
      readCommand: async () => {
        now = 101;
        return {
          programArguments: [process.execPath, "openclaw.mjs", "gateway"],
          environment: { HOME: home },
        };
      },
    });
    const result = await maybeStopManagedServiceBeforeMutableUpdate({
      ...maintenanceDefaults,
      timeoutMs: 100,
      phase: "inspect",
    });
    expect(result.serviceMutationSkipMessage).toContain("Service inspection deadline expired.");
    expect(result.serviceMutationSkipMessage).toContain("Stalled check: service load state.");
  }));

it("reports observed service facts without inferring a manual launch when inspection times out", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const verdict = await inspectManagedGatewayServiceBeforeUpdate({
      root: process.cwd(),
      state: {
        env: { HOME: home },
        installed: true,
        running: false,
        command: {
          programArguments: [process.execPath, "openclaw.mjs", "gateway"],
          sourcePath: path.join(home, ".config/systemd/user/openclaw-gateway.service"),
        },
        loadState: { status: "unknown", detail: "manager timeout" },
        inspectionReason: "systemd-inspection-deadline-exceeded",
        runtime: {
          status: "unknown",
          pid: 4242,
          inspectionFailure: {
            code: "service-runtime-inspection-failed",
            detail: "Stalled check: effective command LoadUnit.",
          },
        },
      },
    });
    expect(verdict.kind).toBe("unavailable");
    if (verdict.kind !== "unavailable") {
      throw new Error("Expected unavailable inspection");
    }
    expect(verdict.message).toContain("service definition is present");
    expect(verdict.message).toContain("Stalled check: effective command LoadUnit.");
    expect(verdict.message).toContain("openclaw gateway stop");
    expect(verdict.message).toContain("openclaw update repair");
    expect(verdict.message).not.toContain("manually");
  }));

it.each(["update", "doctor"] as const)(
  "rechecks the parent deadline after async service preparation and before stopping: %s",
  (entrypoint) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      let wallNow = 1_000;
      let elapsedMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
      const deadlineAtMs = 1_500;
      vi.spyOn(Date, "now").mockImplementation(() => wallNow);
      const remaining = createDoctorServiceInspectionBudget(deadlineAtMs);
      const service = mockMaintenanceService(home);
      mocks.prepareStop.mockImplementationOnce(async () => {
        wallNow = deadlineAtMs + 1;
        elapsedMs = 501;
        return { kind: "unchanged" as const };
      });
      const expectedService = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        phase: "inspect",
      });
      vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
      const stop =
        entrypoint === "doctor"
          ? beginDoctorMaintenance({
              root: process.cwd(),
              options: { repair: true },
              runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
              serviceInspectionDeadlineAtMs: deadlineAtMs,
            })
          : maybeStopManagedServiceBeforeMutableUpdate({
              root: process.cwd(),
              updateInstallKind: "package",
              shouldRestart: true,
              jsonMode: true,
              expectedService,
              timeoutMs: deadlineAtMs - wallNow,
              assertDeadline: () => remaining(),
            });

      await expect(stop).rejects.toThrow("Doctor service-inspection deadline has expired.");
      expect(service.stop).not.toHaveBeenCalled();
    }),
);

it.each(["authority-lost", "ordinary"] as const)(
  "preserves Doctor stop guidance through native preparation failure: %s",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
      let current = true;
      const lost = new Error("Doctor update admission changed during drain cleanup");
      const assertAdmission = () => assert.ok(current, lost);
      vi.spyOn(doctorAdmission, "resolveDoctorUpdateAdmission").mockReturnValue({
        assertCurrent: assertAdmission,
        readContinuation: () => {
          assertAdmission();
          return undefined;
        },
        recordContinuation: assertAdmission,
      });
      const service = mockMaintenanceService(home, { stop: vi.fn() });
      const refusal =
        scenario === "ordinary"
          ? new Error("native preparation failed")
          : new GatewayServiceStopUnsafeError(
              "Gateway stop refused: migration still holds write custody.",
            );
      mocks.drain.mockImplementationOnce(async () => {
        // The drain awaits resume before its refusal escapes; admission may change there.
        current = scenario !== "authority-lost";
        throw refusal;
      });
      const error = await beginDoctorMaintenance({
        root: process.cwd(),
        options: { repair: true },
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      }).catch((reason: unknown) => reason);
      expect(collectNestedErrorCandidates(error)).toContain(refusal);
      if (scenario === "authority-lost") {
        expect(collectNestedErrorCandidates(error)).toContain(lost);
        expect(
          collectNestedErrorCandidates(error).some(
            (cause) => cause instanceof AggregateError && cause.errors.includes(refusal),
          ),
        ).toBe(true);
      }
      expect(String(error).includes("Stop the Gateway service and other OpenClaw processes")).toBe(
        scenario === "ordinary",
      );
      expectNoServiceCalls(service.stop, service.restart);
    }),
);

const maintenanceOperations = [
  "doctor",
  "warning",
  "refresh",
  "no-restart",
  "no-restart-text",
  "changed-during-refresh",
];
it.each(maintenanceOperations)(
  "refreshes maintenance policy while retaining the admitted service: %s",
  (operation) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      let timeout = 30;
      const command = {
        ...gatewayCommand(home),
        environment: { HOME: home, OPENCLAW_SERVICE_VERSION: "2026.7.1-2" },
      };
      const service = mockMaintenanceService(home, {
        readCommand: async () => structuredClone(command),
        readRuntime: async () => ({
          status: operation === "offline" ? "stopped" : "running",
          pid: operation === "offline" ? undefined : fixtureGatewayPid,
          systemd: { managerUid: 2001 },
        }),
        stop: vi.fn(async () => {
          expect(timeout).toBe(330);
        }),
      });
      mocks.prepareStop.mockImplementation(async () => {
        timeout = 330;
        if (operation === "changed-during-refresh") {
          command.environment.OPENCLAW_SERVICE_VERSION = "2026.9.6";
        }
        return { kind: "refreshed" };
      });
      const runId =
        operation === "warning" || operation.startsWith("no-restart")
          ? createUpdateRun({ trigger: "cli" }).runId
          : undefined;
      const warning =
        "Resident budget 25000ms: admitted turn interrupted; next Gateway starts with 330s.";
      mocks.drain.mockImplementationOnce(async ({ warn }, stop) => {
        if (operation === "refused") {
          throw new Error(
            "Gateway maintenance stop refused: data at risk in owner phase session-mutation",
          );
        }
        if (runId) {
          warn(warning);
        }
        await stop();
      });
      const updateRun = runId ? { runId, env: process.env } : undefined;
      const { recordPhase } = createUpdateCommandExecutionGuards({ run: updateRun }, process.cwd());
      const params = {
        ...maintenanceDefaults,
        shouldRestart: !operation.startsWith("no-restart"),
        jsonMode: operation !== "no-restart-text",
        warn: vi.fn(),
        updateRun,
        recordPhase,
      };
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "inspect",
      });
      expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
      if (operation === "doctor" && inspected.serviceUpdateVerdict?.kind === "owned") {
        inspected.serviceUpdateVerdict.refreshDefinition = false;
      }
      try {
        const stop = maybeStopManagedServiceBeforeMutableUpdate({
          ...params,
          expectedService: inspected,
          ...(operation === "refresh" ? { phase: "refresh" as const } : {}),
        });
        if (operation === "refused" || operation === "changed-during-refresh") {
          await expect(stop).rejects.toThrow(
            operation === "refused" ? "owner phase session-mutation" : "definition changed",
          );
          expect(service.stop).not.toHaveBeenCalled();
          return;
        }
        const stopped = await stop;
        if (operation.startsWith("no-restart")) {
          assert(runId);
          expect(params.warn).toHaveBeenCalledExactlyOnceWith(
            "--no-restart skips only the updater's managed restart; the running Gateway will restart itself when it detects the replaced package installation.",
          );
          expect(getUpdateRun(runId)?.steps).toContainEqual(
            expect.objectContaining({
              step: expect.stringMatching(/^warning:gateway-maintenance:/),
              detail:
                "--no-restart skips only the updater's managed restart; the running Gateway will restart itself when it detects the replaced package installation.",
            }),
          );
        }
        if (["offline", "refresh", "no-restart", "no-restart-text"].includes(operation)) {
          expect(timeout).toBe(330);
          expect(stopped.stopped).toBe(false);
          expectNoServiceCalls(service.stop, service.start, service.restart);
          return;
        }
        expect(service.stop).toHaveBeenCalledOnce();
        expect(mocks.drain).toHaveBeenCalledOnce();
        if (runId) {
          expect(getUpdateRun(runId)?.steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                step: expect.stringMatching(/^warning:gateway-maintenance:/),
                detail: warning,
              }),
            ]),
          );
        }
        expect(stopped.serviceDefinitionEnv?.OPENCLAW_SERVICE_VERSION).toBe("2026.7.1-2");
        const restored = await revalidateManagedGatewayServiceAfterUpdate({
          root: params.root,
          state: await readGatewayServiceState(service, { env: stopped.serviceEnv }),
          preManagedServiceStop: stopped,
        });
        expect(restored).toMatchObject({
          kind: "owned",
          refreshDefinition: operation !== "doctor",
        });
      } finally {
        await closeStateDatabaseForTest();
      }
    }),
);

it("explains a blocked systemd inspection for a failed unit with residual tasks", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const service = mockMaintenanceService(home, {
      isLoaded: async () => false,
      readRuntime: async () => ({
        status: "unknown",
        state: "failed",
        systemd: { managerUid: 2001, tasksCurrent: 2 },
      }),
    });
    const result = await maybeStopManagedServiceBeforeMutableUpdate({
      ...maintenanceDefaults,
      phase: "inspect",
    });
    expect(result.serviceUpdateVerdict?.kind).toBe("unavailable");
    expect(result.serviceMutationSkipMessage).toContain(
      "Processes remain in the systemd service cgroup",
    );
    expect(service.stop).not.toHaveBeenCalled();
  }));

it.each(["systemd-user-bus-unavailable", "native-exception", undefined] as const)(
  "explains lost inspection after admission without claiming identity drift: %s",
  (reason) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      let available = true;
      const service = mockMaintenanceService(home, {
        readCommand: async () => {
          if (!available && reason === "native-exception") {
            throw new ServiceInspectionError("systemd-user-bus-unavailable");
          }
          return gatewayCommand(home);
        },
        readRuntime: async () => {
          if (!available) {
            throw reason
              ? new ServiceInspectionError(
                  reason === "native-exception" ? "systemd-user-bus-unavailable" : reason,
                )
              : new Error("private-runtime-detail");
          }
          return { status: "running", pid: fixtureGatewayPid, systemd: { managerUid: 2001 } };
        },
      });
      const params = maintenanceDefaults;
      const before = await maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "inspect",
      });
      expect(before.serviceUpdateVerdict?.kind).toBe("owned");
      available = false;
      const failure = await maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "prepare",
        expectedService: before,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GatewayServiceUpdateOwnershipError);
      if (!(failure instanceof GatewayServiceUpdateOwnershipError)) {
        throw new Error("Expected service inspection refusal");
      }
      if (reason === "native-exception") {
        expect(failure.message).toContain("systemd");
        expectNoServiceCalls(service.stop, service.start, service.install);
        return;
      }
      const detail = reason
        ? (formatServiceInspectionReason(reason).split(".", 1)[0] ?? "")
        : "Gateway service inspection is unavailable";
      for (const message of [
        detail,
        `Failing check managed-service-runtime (${reason ?? "service-ownership-unverified"})`,
        `Update install root: ${process.cwd()}`,
        `Gateway install root: ${process.cwd()}`,
        `Update binary: ${path.join(process.cwd(), "openclaw.mjs")}`,
        "Required: admitted service ownership owned; manager UID 2001; detected: unavailable; runtime unknown; manager UID unavailable",
        "openclaw gateway status --deep",
      ]) {
        expect(failure.message).toContain(message);
      }
      for (const message of ["identity changed", "private-runtime-detail"]) {
        expect(failure.message).not.toContain(message);
      }
      expect(failure.failureFacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "managed-service-runtime",
            code: reason ?? "service-ownership-unverified",
            message:
              "Required: admitted service ownership owned; manager UID 2001; detected: unavailable; runtime unknown; manager UID unavailable",
          }),
        ]),
      );
      expect(failure.failureFacts.length).toBeLessThanOrEqual(5);
      expect(failure.failureFacts.every((fact) => (fact.message?.length ?? 0) <= 200)).toBe(true);
      const result = createUpdateCommandFailureResult({
        mode: "npm",
        durationMs: 0,
        admission: true,
        failure: { cause: failure },
      });
      expect(result.reason).toBe("managed-service-preflight");
      expect(result.failedStep.stderrTail).toContain(
        "installation and Gateway were left unchanged",
      );
      expect(result.failedStep.failureFacts).toEqual(failure.failureFacts);

      const verdict = await inspectManagedGatewayServiceBeforeUpdate({
        root: params.root,
        state: await readGatewayServiceState(service),
      });
      expect(() => assertGatewayServiceAdmissionUnchanged(before, verdict)).toThrow(
        reason ? detail : "Gateway service inspection is unavailable",
      );
      if (reason) {
        expect(collectServiceInspectionFailureFacts(verdict)?.[0]).toMatchObject({
          code: reason,
          message: expect.stringContaining(detail.slice(0, 80)),
        });
      }
      expectNoServiceCalls(service.stop, service.start, service.restart, service.install);
    }),
);

it.each(nativeOfflineCases)(
  "requires affirmative native offline proof for owned $platform service ($label)",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform(scenario.platform);
      mocks.taskState = scenario.state ?? 3;
      const isEnabled = vi.fn<NonNullable<GatewayService["isEnabled"]>>(async () => {
        if (scenario.enabled === undefined) {
          throw new Error("enabled state unavailable");
        }
        return scenario.enabled;
      });
      const command = mockRegisteredWindowsLauncher(home, scenario.state === 4);
      const service = mockMaintenanceService(home, {
        readCommand: async () => command,
        readRuntime:
          scenario.platform === "win32"
            ? readScheduledTaskRuntime
            : async () => ({
                status: scenario.runtime,
                ...(scenario.platform === "linux" ? { systemd: { managerUid: 2001 } } : {}),
              }),
        isLoaded: async () => scenario.loaded,
        isEnabled,
      });
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        ...maintenanceDefaults,
        phase: scenario.phase ?? "inspect",
        timeoutMs: 200,
      });
      expect(inspected.serviceUpdateVerdict?.kind).toBe(
        scenario.runtime === "unknown" ? "unavailable" : "owned",
      );
      expect(inspected.offline).toBe(scenario.runtime === "unknown" ? undefined : scenario.offline);
      for (const [args] of isEnabled.mock.calls) {
        expect(args.timeoutMs).toBe(200);
      }
      expectNoServiceCalls(
        service.stop,
        service.start,
        service.restart,
        service.stage,
        service.install,
      );
    }),
);

it("refuses an admitted Scheduled Task after repeated probe timeouts", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    vi.spyOn(performance, "now").mockReturnValue(1_000); // Native mocks consume no time.
    mocks.taskState = 4;
    vi.mocked(spawnSync).mockReset();
    for (let attempt = 0; attempt < 2; attempt++) {
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), {
          code: "ETIMEDOUT",
        }),
      });
    }
    const command = mockRegisteredWindowsLauncher(home, true);
    const service = mockMaintenanceService(home, {
      readCommand: vi.fn(async () => command),
      readRuntime: readScheduledTaskRuntime,
    });

    const inspection = maybeStopManagedServiceBeforeMutableUpdate({
      ...maintenanceDefaults,
      phase: "inspect",
      timeoutMs: 30_000,
      expectedService: {
        serviceUpdateVerdict: {
          kind: "owned",
          root: process.cwd(),
          fingerprint: "admitted-definition",
          refreshDefinition: true,
        },
      },
    });

    await expect(inspection).rejects.toThrow("Scheduled Task check timed out after 30000 ms");
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]?.timeout).toBe(
        call[1]?.some((arg) => arg.includes("Get-CimInstance Win32_Process")) ? 5_000 : 30_000,
      );
    }
    expectNoServiceCalls(service.stop, service.install);
  }));

it("preserves a silent Scheduled Task probe failure through update and Doctor warnings", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: 2,
      signal: null,
    });
    const service = mockMaintenanceService(home, {
      readRuntime: readScheduledTaskRuntime,
    });
    const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
      ...maintenanceDefaults,
      phase: "inspect",
    });
    expect(inspection).toMatchObject({
      stopped: false,
      serviceMutationAllowed: false,
      serviceUpdateVerdict: { kind: "unavailable" },
    });
    const detail = "Scheduled Task check failed (exit 2): no output from PowerShell.";
    expect(inspection.blockMessage).toBeUndefined();
    expect(inspection.serviceMutationSkipMessage).toContain(detail);
    const maintenance = await beginDoctorMaintenance({
      root: process.cwd(),
      options: { repair: true },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    try {
      expect(maintenance?.warnings).toEqual([expect.stringContaining(detail)]);
      expect(maintenance?.warnings?.[0]).toContain("openclaw gateway stop");
      await maintenance?.finish({});
    } finally {
      await maintenance?.release();
    }
    expectNoServiceCalls(service.stop, service.install, service.restart);
  }));

it("refuses owned Linux admission without a native manager UID", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const stop = vi.fn(async () => undefined);
    mockMaintenanceService(home, {
      readRuntime: async () => ({ status: "running" }),
      stop,
    });
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        ...maintenanceDefaults,
        phase: "inspect",
      }),
    ).resolves.toMatchObject({
      serviceUpdateVerdict: { kind: "unavailable" },
      serviceMutationAllowed: false,
    });
    expect(stop).not.toHaveBeenCalled();
  }));

it.each(["before stop", "after stop"] as const)(
  "refuses a rebound live executor %s without a new native effect",
  (when) =>
    withServiceHome(async (home) => {
      vi.spyOn(openClawTmp, "resolvePreferredOpenClawTmpDir").mockReturnValue(
        path.join(home, "private-tmp"),
      );
      const root = process.cwd();
      const runId = randomUUID();
      createUpdateRun({ runId, trigger: "cli" }, { env: process.env });
      let reads = 0;
      const store = createManagedHandoffLeaseStore();
      const revoke = () => {
        const found = store.read(root);
        if (found.kind !== "current") {
          throw new Error("missing actual executor");
        }
        expect(store.bind(found.lease, process.pid)).not.toBeNull();
      };
      const stop = vi.fn(async () => {
        if (when === "after stop") {
          revoke();
        }
      });
      mockMaintenanceService(home, {
        readCommand: async () => gatewayCommand(home, root),
        readRuntime: async () => {
          reads += 1;
          await Promise.resolve();
          if (reads === 2 && when === "before stop") {
            revoke();
          }
          return {
            status: "running",
            pid: fixtureGatewayPid,
            systemd: { managerUid: process.getuid?.() ?? 2001 },
          };
        },
        isEnabled: async () => true,
        stop,
      });
      let nativeFailure: unknown;
      try {
        await expect(
          withUpdateCommandExecutor(runId, async (executor) => {
            const executorFence = await executor.enter(root);
            const updateRun = { runId, env: { ...process.env }, executorFence };
            const { recordPhase } = createUpdateCommandExecutionGuards({ run: updateRun }, root);
            try {
              await maybeStopManagedServiceBeforeMutableUpdate({
                updateRun,
                recordPhase,
                ...maintenanceDefaults,
                root,
                phase: "prepare",
              });
            } catch (error) {
              nativeFailure = error;
            }
          }),
        ).rejects.toThrow(/executor/);
        expect(String(nativeFailure)).toMatch(/executor/);
        expect(stop).toHaveBeenCalledTimes(when === "before stop" ? 0 : 1);
        expect(store.read(root).kind).toBe("current");
      } finally {
        await closeStateDatabaseForTest();
      }
    }),
);
