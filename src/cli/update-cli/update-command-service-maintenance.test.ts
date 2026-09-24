// Install the native service fixtures before loading the maintenance owner.
import "./update-command-service-maintenance.test-support.js";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { expect, it, vi } from "vitest";
import * as doctorAdmission from "../../commands/doctor-maintenance-admission.js";
import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import * as doctorServicePolicy from "../../commands/doctor-service-repair-policy.js";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import { readScheduledTaskRuntime } from "../../daemon/schtasks-runtime.js";
import {
  GatewayServiceStopUnsafeError,
  ServiceInspectionError,
  formatServiceInspectionReason,
} from "../../daemon/service-inspection-error.js";
import { readGatewayServiceState, type GatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import * as openClawTmp from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  collectServiceInspectionFailureFacts,
  createUpdateCommandFailureResult,
} from "./update-command-result.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  revalidateManagedGatewayServiceAfterUpdate,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import {
  assertGatewayServiceAdmissionUnchanged,
  GatewayServiceUpdateOwnershipError,
  inspectManagedGatewayServiceBeforeUpdate,
} from "./update-command-service-plan.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it.each(["direct", "authority-lost", "ordinary"] as const)(
  "preserves Doctor stop guidance through native preparation failure: %s",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      vi.spyOn(doctorServicePolicy, "shouldManageGatewayService").mockResolvedValue(true);
      let current = true;
      const lost = new Error("Doctor update admission changed during drain cleanup");
      vi.spyOn(doctorAdmission, "resolveDoctorUpdateAdmission").mockReturnValue(() => {
        if (!current) {
          throw lost;
        }
      });
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running", systemd: { managerUid: 2001 } }),
        isLoaded: async () => true,
        stop: vi.fn(),
      });
      mocks.service.mockReturnValue(service);
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
            (candidate) =>
              candidate instanceof AggregateError && candidate.errors.includes(refusal),
          ),
        ).toBe(true);
      }
      expect(String(error).includes("Stop the Gateway service and other OpenClaw processes")).toBe(
        scenario === "ordinary",
      );
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
    }),
);

it.each([
  "update",
  "doctor",
  "refused",
  "warning",
  "offline",
  "refresh",
  "no-restart",
  "changed-during-refresh",
])("refreshes maintenance policy while retaining the admitted service: %s", (operation) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    let timeout = 30;
    const command = {
      programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
      environment: { HOME: home, OPENCLAW_SERVICE_VERSION: "2026.7.1-2" },
    };
    const service = createMockGatewayService({
      readCommand: async () => structuredClone(command),
      isLoaded: async () => true,
      readRuntime: async () => ({
        status: operation === "offline" ? "stopped" : "running",
        systemd: { managerUid: 2001 },
      }),
      stop: vi.fn(async () => {
        expect(timeout).toBe(330);
      }),
    });
    mocks.service.mockReturnValue(service);
    mocks.prepareStop.mockImplementation(async () => {
      timeout = 330;
      if (operation === "changed-during-refresh") {
        command.environment.OPENCLAW_SERVICE_VERSION = "2026.9.6";
      }
      return true;
    });
    const runId = operation === "warning" ? createUpdateRun({ trigger: "cli" }).runId : undefined;
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
    const params = {
      root: process.cwd(),
      updateInstallKind: "package" as const,
      shouldRestart: operation !== "no-restart",
      jsonMode: true,
      ...(runId ? { updateRun: { runId, env: process.env } } : {}),
    };
    const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "inspect",
    });
    expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
    if (operation === "doctor" && inspected.serviceUpdateVerdict?.kind === "owned") {
      inspected.serviceUpdateVerdict.refreshDefinition = false;
    }
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
    if (["offline", "refresh", "no-restart"].includes(operation)) {
      expect(timeout).toBe(330);
      expect(stopped.stopped).toBe(false);
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
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
    expect(restored).toMatchObject({ kind: "owned", refreshDefinition: operation !== "doctor" });
  }),
);

it.each(["systemd-user-bus-unavailable", "service-manager-access-denied"] as const)(
  "retains the native inspection reason without service authority: %s",
  (reason) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "unknown", inspectionReason: reason }),
        isLoaded: async () => {
          throw new ServiceInspectionError(reason);
        },
      });
      mocks.service.mockReturnValue(service);
      const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "inspect",
        jsonMode: true,
      });
      expect(inspection.serviceUpdateVerdict).toMatchObject({
        kind: "unavailable",
        inspectionReason: reason,
      });
      expect(inspection.serviceEnv === undefined).toBe(true);
      expect(inspection.serviceDefinitionEnv === undefined).toBe(true);
      expect(inspection.serviceNodeRunner === undefined).toBe(true);
      expect(service.stop).not.toHaveBeenCalled();
    }),
);

it.each([
  { state: "failed", tasksCurrent: 2, residual: true },
  { state: "inactive", tasksCurrent: 1, residual: true },
  { state: "failed", tasksCurrent: undefined, residual: false },
  { state: "activating", tasksCurrent: 2, residual: false },
])("explains a blocked systemd inspection for $state with $tasksCurrent tasks", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const service = createMockGatewayService({
      readCommand: async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      }),
      readRuntime: async () => ({
        status: "unknown",
        state: scenario.state,
        systemd: { managerUid: 2001, tasksCurrent: scenario.tasksCurrent },
      }),
    });
    mocks.service.mockReturnValue(service);
    const result = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
    });
    expect(result.serviceUpdateVerdict?.kind).toBe("unavailable");
    expect(result.serviceMutationSkipMessage).toContain(
      scenario.residual
        ? "Processes remain in the systemd service cgroup"
        : "Gateway service inspection is unavailable",
    );
    expect(service.stop).not.toHaveBeenCalled();
  }),
);

it.each(["systemd-user-bus-unavailable", "service-manager-access-denied", undefined] as const)(
  "explains lost inspection after admission without claiming identity drift: %s",
  (reason) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      let available = true;
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => {
          if (!available) {
            throw reason ? new ServiceInspectionError(reason) : new Error("private-runtime-detail");
          }
          return { status: "running", systemd: { managerUid: 2001 } };
        },
        isLoaded: async () => true,
      });
      mocks.service.mockReturnValue(service);
      const params = {
        root: process.cwd(),
        updateInstallKind: "package" as const,
        shouldRestart: true,
        jsonMode: true,
      };
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
      const detail = reason
        ? formatServiceInspectionReason(reason)
        : "Gateway service ownership could not be verified because inspection is unavailable.";
      expect(failure.message).toContain(detail);
      expect(failure.message).not.toContain("identity changed");
      expect(failure.message).not.toContain("private-runtime-detail");
      expect(failure.failureFacts).toEqual([
        expect.objectContaining({
          check: "managed-service",
          code: reason ?? "service-ownership-unverified",
          message: expect.stringContaining(detail.slice(0, 80)),
        }),
      ]);
      const result = createUpdateCommandFailureResult({
        mode: "npm",
        durationMs: 0,
        admission: true,
        failure: { cause: failure },
      });
      expect(result.reason).toBe("managed-service-preflight");
      expect(result.failedStep.failureFacts).toEqual(failure.failureFacts);

      const verdict = await inspectManagedGatewayServiceBeforeUpdate({
        root: params.root,
        state: await readGatewayServiceState(service),
      });
      expect(() => assertGatewayServiceAdmissionUnchanged(before, verdict)).toThrow(detail);
      if (reason) {
        expect(collectServiceInspectionFailureFacts(verdict)?.[0]).toMatchObject({
          code: reason,
          message: expect.stringContaining(detail.slice(0, 80)),
        });
      }
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    }),
);

type NativeOfflineCase = {
  platform: NodeJS.Platform;
  label: string;
  runtime: "running" | "stopped" | "unknown";
  loaded: boolean;
  offline: boolean;
  enabled?: boolean;
  phase?: "inspect" | "prepare";
  state?: number | string;
};

const nativeOfflineCases: NativeOfflineCase[] = [
  {
    platform: "linux",
    label: "terminal inactive",
    runtime: "stopped",
    loaded: true,
    offline: true,
  },
  {
    platform: "linux",
    label: "restart transition",
    runtime: "unknown",
    loaded: true,
    offline: false,
  },
  { platform: "linux", label: "running", runtime: "running", loaded: true, offline: false },
  { platform: "darwin", label: "unloaded", runtime: "stopped", loaded: false, offline: true },
  {
    platform: "darwin",
    label: "loaded enabled",
    runtime: "stopped",
    loaded: true,
    enabled: true,
    offline: false,
  },
  {
    platform: "darwin",
    label: "loaded disabled",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: false,
  },
  {
    platform: "darwin",
    label: "loaded disabled preparation",
    runtime: "stopped",
    loaded: true,
    enabled: false,
    offline: false,
    phase: "prepare",
  },
  {
    platform: "darwin",
    label: "enabled unknown",
    runtime: "stopped",
    loaded: true,
    offline: false,
  },
  ...[
    { label: "disabled", state: 1, offline: true },
    { label: "ready", state: 3, offline: true },
    { label: "queued", state: 2, offline: false },
    { label: "running", state: 4, offline: false },
    { label: "unknown", state: 0, offline: false },
    { label: "malformed", state: "3 trailing output", offline: false },
  ].map<NativeOfflineCase>((task) => ({
    platform: "win32",
    runtime:
      task.state === 1 || task.state === 3 ? "stopped" : task.state === 4 ? "running" : "unknown",
    loaded: true,
    label: task.label,
    state: task.state,
    offline: task.offline,
  })),
];

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
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
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
      mocks.service.mockReturnValue(service);
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        phase: scenario.phase ?? "inspect",
        jsonMode: true,
        timeoutMs: 200,
      });
      expect(inspected.serviceUpdateVerdict?.kind).toBe(
        scenario.runtime === "unknown" ? "unavailable" : "owned",
      );
      expect(inspected.offline).toBe(scenario.runtime === "unknown" ? undefined : scenario.offline);
      for (const [args] of isEnabled.mock.calls) {
        expect(args.timeoutMs).toBe(200);
      }
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.stage).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
    }),
);

it.each([
  { code: "ETIMEDOUT", failures: 1, recovered: true },
  { code: "ETIMEDOUT", failures: 2, recovered: false },
  { code: "ETIMEDOUT", failures: 2, recovered: false, admitted: true },
  { code: "ENOENT", failures: 1, recovered: false },
])("handles Scheduled Task probe failures before update: %j", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("win32");
    mocks.taskState = 4;
    vi.mocked(spawnSync).mockReset();
    for (let attempt = 0; attempt < scenario.failures; attempt++) {
      vi.mocked(spawnSync).mockReturnValueOnce({
        pid: 0,
        output: [null, "", ""],
        stdout: "",
        stderr: "",
        status: null,
        signal: null,
        error: Object.assign(new Error(`spawnSync powershell.exe ${scenario.code}`), {
          code: scenario.code,
        }),
      });
    }
    const service = createMockGatewayService({
      readCommand: vi.fn(async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      })),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);

    const inspection = maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
      timeoutMs: 30_000,
      expectedService: scenario.admitted
        ? {
            serviceUpdateVerdict: {
              kind: "owned",
              root: process.cwd(),
              fingerprint: "admitted-definition",
              refreshDefinition: true,
            },
          }
        : undefined,
    });

    if (scenario.admitted) {
      await expect(inspection).rejects.toThrow("Scheduled Task probe timed out after 5000 ms");
    } else {
      const inspected = await inspection;
      expect(inspected.blockMessage).toBeUndefined();
      if (scenario.recovered) {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("owned");
        expect(inspected.running).toBe(true);
      } else {
        expect(inspected.serviceUpdateVerdict?.kind).toBe("unavailable");
        expect(inspected.serviceMutationSkipMessage).toContain(
          "Restart the Gateway you launched manually after the update.",
        );
        if (scenario.code === "ETIMEDOUT") {
          expect(inspected.serviceMutationSkipMessage).toContain(
            "Scheduled Task probe timed out after 5000 ms",
          );
          expect(inspected.serviceMutationSkipMessage).toContain("ETIMEDOUT");
        }
      }
    }
    const attempts = scenario.code === "ETIMEDOUT" ? 2 : 1;
    expect(spawnSync).toHaveBeenCalledTimes(attempts);
    expect(service.readCommand).toHaveBeenCalledTimes(attempts);
    for (const call of vi.mocked(spawnSync).mock.calls) {
      expect(call[2]?.timeout).toBe(5_000);
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  }),
);

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
    const service = createMockGatewayService({
      readCommand: async () => ({
        programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        environment: { HOME: home },
      }),
      readRuntime: readScheduledTaskRuntime,
      isLoaded: async () => true,
    });
    mocks.service.mockReturnValue(service);
    const inspection = await maybeStopManagedServiceBeforeMutableUpdate({
      root: process.cwd(),
      updateInstallKind: "package",
      shouldRestart: true,
      phase: "inspect",
      jsonMode: true,
    });
    expect(inspection).toMatchObject({
      stopped: false,
      serviceMutationAllowed: false,
      serviceUpdateVerdict: { kind: "unavailable" },
    });
    const detail = "Scheduled Task probe failed (exit 2): no output from PowerShell.";
    expect(inspection.blockMessage).toBeUndefined();
    expect(inspection.serviceMutationSkipMessage).toContain(detail);
    const maintenance = await beginDoctorMaintenance({
      root: process.cwd(),
      options: { repair: true },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    try {
      expect(maintenance?.warnings).toEqual([expect.stringContaining(detail)]);
      expect(maintenance?.warnings?.[0]).toContain(
        "Restart the Gateway you launched manually after the update.",
      );
      await maintenance?.finish({});
    } finally {
      await maintenance?.release();
    }
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
    expect(service.restart).not.toHaveBeenCalled();
  }));

it.each([
  { label: "changed account", uid: 3002 },
  { label: "missing account", uid: undefined },
  { label: "same account", uid: 2001 },
])("revalidates native manager identity before preparation: $label", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    let managerUid: number | undefined = 2001;
    const stop = vi.fn(async () => undefined);
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running", systemd: { managerUid } }),
        isLoaded: async () => true,
        stop,
      }),
    );
    const params = {
      updateInstallKind: "package" as const,
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect" as const,
    };
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    expect(before.serviceUpdateVerdict?.kind).toBe("owned");
    expect(before).toMatchObject({ serviceManagerUid: 2001 });
    managerUid = scenario.uid;
    const next = maybeStopManagedServiceBeforeMutableUpdate({
      ...params,
      phase: "prepare",
      expectedService: before,
    });
    if (scenario.uid === 2001) {
      await expect(next).resolves.toMatchObject({
        stopped: true,
        serviceManagerUid: 2001,
        serviceUpdateVerdict: { kind: "owned" },
      });
    } else {
      await expect(next).rejects.toThrow(/ownership|manager identity/);
    }
    expect(stop).toHaveBeenCalledTimes(scenario.uid === 2001 ? 1 : 0);
  }),
);

it("retains the inspected systemd manager route during preparation", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const seenRoutes: Array<string | undefined> = [];
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async (env) => {
          seenRoutes.push(env.DBUS_SESSION_BUS_ADDRESS);
          return {
            programArguments: [
              process.execPath,
              path.join(process.cwd(), "openclaw.mjs"),
              "gateway",
            ],
            environment: { HOME: home },
          };
        },
        readRuntime: async () => ({ status: "running", systemd: { managerUid: 2001 } }),
        isLoaded: async () => true,
        stop: async () => undefined,
      }),
    );
    const params = {
      updateInstallKind: "package" as const,
      root: process.cwd(),
      shouldRestart: true,
      jsonMode: true,
      phase: "inspect" as const,
    };
    const before = await maybeStopManagedServiceBeforeMutableUpdate(params);
    const admittedRoute = "unix:path=/run/user/2001/bus";
    before.serviceEnv = {
      ...before.serviceEnv,
      DBUS_SESSION_BUS_ADDRESS: admittedRoute,
    };
    const readsBeforePreparation = seenRoutes.length;

    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        ...params,
        phase: "prepare",
        expectedService: before,
      }),
    ).resolves.toMatchObject({ stopped: true });

    expect(new Set(seenRoutes.slice(readsBeforePreparation))).toEqual(new Set([admittedRoute]));
  }));

it.each([
  "shipped handoff",
  "matching UID",
  "mismatching UID",
  "unavailable manager",
  "different unit",
  "different profile",
  "foreign executable",
  "unchanged protected command",
  "changed protected command",
  "changed protected environment",
  "changed protected working directory",
  "changed protected override",
])("revalidates the shipped managed-service stop record: %s", (scenario) =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const root = process.cwd();
    const command = {
      programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
      environment: { HOME: home },
    };
    const protectedCommand = scenario.includes("protected");
    // Stable updaters through v2026.9.4 omit metadata for known-empty systemd overrides.
    const before: PreManagedServiceStop = {
      stoppedAtMs: 1,
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      offline: false,
      serviceEnv: { HOME: home },
      serviceDefinitionEnv: command.environment,
      serviceNodeRunner: process.execPath,
      serviceUpdateVerdict: {
        kind: "owned",
        root,
        fingerprint: sha256Hex(stableStringify(command)),
        refreshDefinition: !protectedCommand,
      },
    };
    if (scenario === "matching UID" || scenario === "mismatching UID") {
      before.serviceManagerUid = scenario === "matching UID" ? 2001 : 3002;
    }
    const service = createMockGatewayService({
      readCommand: async () => ({
        ...command,
        ...(protectedCommand
          ? {
              managedDefinition: command,
              managedOverrides:
                scenario === "changed protected override" ? { launcher: "command" as const } : {},
            }
          : {}),
        ...(scenario === "changed protected working directory" ? { workingDirectory: home } : {}),
        programArguments:
          scenario === "foreign executable"
            ? [process.execPath, path.join(home, "other", "openclaw.mjs"), "gateway"]
            : scenario === "changed protected command"
              ? [...command.programArguments, "--verbose"]
              : command.programArguments,
        environment: {
          ...command.environment,
          ...(scenario === "changed protected environment" ? { FIXTURE_VALUE: "changed" } : {}),
          ...(scenario === "different unit" ? { OPENCLAW_SYSTEMD_UNIT: "other-gateway" } : {}),
          ...(scenario === "different profile"
            ? {
                OPENCLAW_PROFILE: "other",
                OPENCLAW_STATE_DIR: path.join(home, ".openclaw-other"),
                OPENCLAW_CONFIG_PATH: path.join(home, ".openclaw-other", "openclaw.json"),
              }
            : {}),
        },
      }),
      readRuntime: async () => ({
        status: "stopped",
        systemd: { managerUid: scenario === "unavailable manager" ? undefined : 2001 },
      }),
      isLoaded: async () => true,
    });
    const state = await readGatewayServiceState(service, {
      env: before.serviceEnv,
      requireEffective: true,
      requireLoadedCommand: true,
    });
    const revalidated = revalidateManagedGatewayServiceAfterUpdate({
      state,
      root,
      preManagedServiceStop: before,
    });
    if (
      scenario === "shipped handoff" ||
      scenario === "matching UID" ||
      scenario === "unchanged protected command"
    ) {
      await expect(revalidated).resolves.toMatchObject({
        kind: "owned",
        refreshDefinition: !protectedCommand,
      });
    } else {
      await expect(revalidated).rejects.toThrow(
        scenario === "unavailable manager"
          ? /inspection is unavailable/
          : /ownership or manager identity changed/,
      );
    }
  }),
);

it("refuses owned Linux admission without a native manager UID", () =>
  withServiceHome(async (home) => {
    mockProcessPlatform("linux");
    const stop = vi.fn(async () => undefined);
    mocks.service.mockReturnValue(
      createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
          environment: { HOME: home },
        }),
        readRuntime: async () => ({ status: "running" }),
        isLoaded: async () => true,
        stop,
      }),
    );
    await expect(
      maybeStopManagedServiceBeforeMutableUpdate({
        updateInstallKind: "package",
        root: process.cwd(),
        shouldRestart: true,
        jsonMode: true,
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
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments: [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
            environment: { HOME: home },
          }),
          readRuntime: async () => {
            reads += 1;
            await Promise.resolve();
            if (reads === 2 && when === "before stop") {
              revoke();
            }
            return { status: "running", systemd: { managerUid: process.getuid?.() ?? 2001 } };
          },
          isLoaded: async () => true,
          isEnabled: async () => true,
          stop,
        }),
      );
      let nativeFailure: unknown;
      await expect(
        withUpdateCommandExecutor(runId, async (executor) => {
          const executorFence = await executor.enter(root);
          try {
            await maybeStopManagedServiceBeforeMutableUpdate({
              updateRun: { runId, env: { ...process.env }, executorFence },
              updateInstallKind: "package",
              root,
              shouldRestart: true,
              jsonMode: true,
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
    }),
);

it.each(["disable", "restore", "compensation", "never"] as const)(
  "retains caller authority when Windows task recovery loses its owner before %s",
  (lostBefore) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("win32");
      let current = true;
      let revokeDuringInspection = false;
      let enabled = true;
      const mutations: string[] = [];
      vi.spyOn(schtasksExec, "execSchtasks").mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          if (lostBefore === "disable") {
            current = false;
          }
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        expect(args[0]).toBe("/Change");
        const action = args.at(-1);
        if (action !== "/ENABLE" && action !== "/DISABLE") {
          throw new Error("Unexpected Scheduled Task mutation");
        }
        mutations.push(action);
        enabled = action === "/ENABLE";
        return { code: 0, stdout: "", stderr: "" };
      });
      mocks.service.mockReturnValue(
        createMockGatewayService({
          readCommand: async () => ({
            programArguments: [
              process.execPath,
              path.join(process.cwd(), "openclaw.mjs"),
              "gateway",
            ],
            environment: { HOME: home },
          }),
          readRuntime: async () => {
            if (revokeDuringInspection) {
              current = false;
            }
            return { status: "running" };
          },
          isLoaded: async () => true,
        }),
      );
      let stopped: PreManagedServiceStop | undefined;
      let failure: unknown;
      try {
        try {
          stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            root: process.cwd(),
            updateInstallKind: "package",
            shouldRestart: lostBefore !== "disable",
            jsonMode: true,
            assertCurrent: () => {
              if (!current) {
                throw new Error("Repair continuation no longer owns this task");
              }
            },
          });
          const recovery = stopped.windowsTaskAutoStartRecovery;
          if (!recovery) {
            throw new Error("Missing Windows task recovery");
          }
          revokeDuringInspection = lostBefore === "restore";
          await recovery.restore();
          revokeDuringInspection = lostBefore === "compensation";
          await recovery.complete(false);
        } catch (error) {
          failure = error;
        }
        expect(mutations).toEqual(
          lostBefore === "disable"
            ? []
            : lostBefore === "restore"
              ? ["/DISABLE"]
              : lostBefore === "compensation"
                ? ["/DISABLE", "/ENABLE"]
                : ["/DISABLE", "/ENABLE", "/DISABLE"],
        );
        expect(enabled).toBe(lostBefore === "disable" || lostBefore === "compensation");
        if (lostBefore === "never") {
          expect(failure).toBeUndefined();
        } else {
          expect(String(failure)).toContain("Repair continuation no longer owns this task");
        }
      } finally {
        await stopped?.windowsTaskAutoStartRecovery?.complete();
      }
    }),
);
