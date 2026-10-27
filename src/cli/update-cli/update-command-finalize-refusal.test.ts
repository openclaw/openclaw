import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as doctorMaintenance from "../../commands/doctor-maintenance.js";
import { SystemdInspectionTimeout } from "../../daemon/service-inspection-error.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../../infra/deferred-plugin-migrations.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as ports from "../../infra/ports-inspect.js";
import * as updateCheck from "../../infra/update-check.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import * as utils from "../../utils.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import * as shared from "./shared.js";
import { cleanupUpdateCommandTest } from "./update-command-cleanup.test-support.js";
import { verifyUpdateFailureRecovery } from "./update-command-failure-recovery.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import {
  prepareFinalizationPackage,
  validConfigSnapshot,
} from "./update-command-lifecycle.test-support.js";
import * as plugins from "./update-command-plugins.js";
import * as sourceRuntime from "./update-command-runtime.js";
import type { PreManagedServiceStop } from "./update-command-service-maintenance.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateRepairCommand } from "./update-repair-command.js";

const native = vi.hoisted(() => ({
  events: [] as string[],
  inspecting: false,
  stopped: false,
  contend: true,
  elapsedMs: 0,
  root: "",
  realOwner: false,
  blockCode: undefined as string | undefined,
}));
vi.mock("../../config/paths.js", async (original) => ({
  ...(await original<typeof import("../../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("../../commands/doctor-service-repair-policy.js", async (original) => ({
  ...(await original<typeof import("../../commands/doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
  isServiceRepairExternallyManaged: () => false,
}));
vi.mock("../../infra/gateway-owner-lease.js", async (original) => ({
  ...(await original<typeof import("../../infra/gateway-owner-lease.js")>()),
  readGatewayOwnerLease: () =>
    native.inspecting && !native.stopped
      ? { state: "live", mode: "supervised", pid: 4242 }
      : undefined,
}));
vi.mock("../../commands/doctor-maintenance-inspection.js", async (original) => ({
  ...(await original<typeof import("../../commands/doctor-maintenance-inspection.js")>()),
  readDoctorGatewayOwnerLease: async () =>
    native.inspecting && !native.stopped
      ? { state: "live", mode: "supervised", pid: 4242 }
      : undefined,
}));
vi.mock("../../infra/gateway-state-owner.js", async (original) => {
  const actual = await original<typeof import("../../infra/gateway-state-owner.js")>();
  return {
    ...actual,
    acquireGatewayStateOwner: (params: Parameters<typeof actual.acquireGatewayStateOwner>[0]) => {
      if (!native.realOwner && native.inspecting && (!native.stopped || native.contend)) {
        native.events.push(native.stopped ? "non-serving-holder" : "running-holder");
        throw new actual.GatewayStateOwnerContentionError(params.databasePath);
      }
      return actual.acquireGatewayStateOwner(params);
    },
  };
});
vi.mock("./update-command-service-maintenance.js", async (original) => {
  const actual = await original<typeof import("./update-command-service-maintenance.js")>();
  return {
    ...actual,
    maybeStopManagedServiceBeforeMutableUpdate: async (
      params: Parameters<typeof actual.maybeStopManagedServiceBeforeMutableUpdate>[0],
    ) => {
      native.inspecting = true;
      if (native.realOwner) {
        return actual.maybeStopManagedServiceBeforeMutableUpdate(params);
      }
      if (params.phase !== "inspect") {
        if (native.blockCode) {
          return {
            stopped: false,
            inspected: true,
            blockMessage: "Synthetic managed-service refusal before stopping the Gateway.",
            blockFailureFacts: [{ check: "managed-service", code: native.blockCode }],
          };
        }
        native.stopped = true;
        // A verified stop can consume the shutdown allowance before ownership clears.
        native.elapsedMs += GATEWAY_SERVICE_STOP_TIMEOUT_MS;
        native.events.push("stop-verified");
      }
      const before: PreManagedServiceStop = {
        stopped: native.stopped,
        inspected: true,
        runtimeInspected: true,
        running: !native.stopped,
        offline: native.stopped,
        serviceEnv: { ...process.env },
        serviceUpdateVerdict: {
          kind: "owned",
          root: native.root,
          fingerprint: "fixture-service",
          refreshDefinition: false,
        },
      };
      if (native.stopped) {
        params.onStopped?.(before);
      }
      return before;
    },
    revalidateManagedGatewayServiceAfterUpdate: async () => ({ kind: "owned", root: native.root }),
  };
});
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({
    readCommand: async () => null,
    readRuntime: async () => ({ status: "stopped", missingUnit: true }),
    isLoaded: async () => false,
    restart: async () => {
      native.events.push("restart");
      native.stopped = false;
    },
  }),
  readGatewayServiceState: async () => {
    if (native.realOwner) {
      throw new SystemdInspectionTimeout("systemctl --user show");
    }
    return {
      env: { ...process.env },
      command: null,
      loadState: { status: "loaded" },
      runtime: { status: "stopped" },
    };
  },
}));
vi.mock("../../daemon/service-operation-lock.js", () => ({
  withGatewayServiceOperationLock: async (
    _env: unknown,
    run: (assertCurrent: () => void) => Promise<unknown>,
  ) => run(() => {}),
}));
vi.mock("../daemon-cli/restart-health.js", async (original) => ({
  ...(await original<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: async () => {
    native.events.push("restart-verified");
    return { outcome: native.stopped ? "failed" : "ready", healthy: !native.stopped };
  },
  renderRestartDiagnostics: () => [],
}));
vi.mock("./update-command-service-plan.js", async (original) => ({
  ...(await original<typeof import("./update-command-service-plan.js")>()),
  resolveUpdatedGatewayRestartPort: async () => 19483,
}));
vi.mock("./update-command-triage.js", () => ({
  withUpdateFailureTriage: async (_opts: unknown, _target: unknown, run: () => Promise<void>) =>
    run(),
}));
vi.mock("./update-command-failure-recovery.js", () => ({
  verifyUpdateFailureRecovery: vi.fn(async (params: { result: unknown }) => params.result),
}));
vi.mock("../../infra/update-candidate-state.sizes.js", () => ({
  readUpdateStateDatabaseSizes: async () => [],
}));
vi.mock("./update-command-config-snapshot.js", () => ({
  createUpdateConfigSnapshot: async () => {},
}));
vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => validConfigSnapshot,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const pending = {
  pluginId: "synthetic-retained-state",
  reason: "Retained migration inputs are still pending.",
  command: "openclaw doctor --fix",
  requiresStateMigration: true as const,
};

const repairOptions = { json: true, yes: true, deferCompletionCache: true };

beforeEach(async () => {
  const base = dirs.make("finalize-refusal-");
  vi.stubEnv("HOME", base);
  vi.stubEnv("USERPROFILE", base);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  mockSystemAccountHome();
  native.root = path.join(base, "package");
  native.realOwner = false;
  native.blockCode = undefined;
  await fs.mkdir(native.root);
  await prepareFinalizationPackage(native.root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, ".openclaw"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, ".openclaw", "openclaw.json"));
  vi.mocked(verifyUpdateFailureRecovery).mockClear();
  for (const key of [
    "OPENCLAW_UPDATE_RUN_ID",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_UPDATE_POST_CORE",
    "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION",
  ]) {
    vi.stubEnv(key, undefined);
  }
  native.events = [];
  native.inspecting = false;
  native.stopped = false;
  native.contend = true;
  native.elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => native.elapsedMs);
  await recordDeferredPluginMigrations({ pending: [pending] });
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(native.root);
  vi.spyOn(freshDoctor, "runUpdateFinalizationDoctorInFreshProcess").mockResolvedValue(undefined);
  vi.spyOn(plugins, "updatePluginsAfterCoreUpdate");
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
});

afterEach(cleanupUpdateCommandTest);

it("keeps repair pending with a real state owner and unavailable systemd inspection", async () => {
  native.realOwner = true;
  const createdAt = "2026-10-19T12:00:00.000Z";
  const owner = acquireGatewayStateOwner({
    databasePath: path.join(process.env.OPENCLAW_STATE_DIR!, "state", "openclaw.sqlite"),
    payload: {
      pid: process.pid,
      processNamespace: readGatewayLockProcessNamespace(),
      role: "gateway",
      createdAt,
      configPath: process.env.OPENCLAW_CONFIG_PATH!,
      port: 19483,
      startTime: getFileLockProcessStartTime(process.pid) ?? undefined,
    },
  });
  try {
    await expect(updateRepairCommand(repairOptions)).rejects.toEqual(new ExitError(2));
    const output = [
      ...vi.mocked(defaultRuntime.error).mock.calls,
      ...vi.mocked(defaultRuntime.log).mock.calls,
    ]
      .flat()
      .join("\n");
    expect(output).toContain(`pid ${process.pid}`);
    expect(output).toContain(createdAt);
    expect(output).toContain("Stalled check: systemctl --user show.");
    expect(output).toContain("openclaw gateway stop");
    expect(output).toContain("openclaw update repair");
    expect(output).not.toContain("manually");
    expect(readDeferredPluginMigrations()).toEqual([pending]);
    expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
    owner.assertCurrent();
  } finally {
    owner.release();
  }
});

it.each([true, false])(
  "restores a stopped service and reports pending repair (json=%s)",
  async (json) => {
    vi.stubEnv("OPENCLAW_PROFILE", "repair-test");
    const nextAction =
      "Stop the Gateway through its service owner (`openclaw --profile repair-test gateway stop --force` for the managed service), stop other OpenClaw processes using this state, then rerun `openclaw --profile repair-test update repair`.";
    const old = createUpdateRun({ trigger: "cli" });
    const history = finishUpdateRun(old.runId, { status: "failed", reason: "abandoned" });
    await expect(updateRepairCommand({ ...repairOptions, json })).rejects.toEqual(new ExitError(2));
    expect(native.events).toEqual([
      "running-holder",
      "stop-verified",
      "non-serving-holder",
      "non-serving-holder",
      "restart",
      "restart-verified",
    ]);
    expect(native.elapsedMs).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
    if (json) {
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "warning",
          nextAction,
          postUpdate: {
            doctor: {
              status: "warning",
              warnings: [
                expect.stringContaining("update repair"),
                expect.stringContaining("GatewayStateOwnerContentionError"),
              ],
            },
          },
        }),
      );
    } else {
      expect(defaultRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining(`Doctor maintenance remains pending. ${nextAction}`),
      );
    }
    const run = listUpdateRuns()[0]!;
    expect(run).toMatchObject({
      status: "skipped",
      reason: "doctor-maintenance-pending",
      origin: { nextAction },
    });
    const report = renderUpdateRunReport(run);
    expect(report.headline).toBe(
      "ℹ️ OpenClaw repair pending: Doctor maintenance remains unfinished.",
    );
    expect(report.markdown).toContain(nextAction);
    expect(report.markdown.indexOf(nextAction)).toBeLessThan(report.markdown.indexOf("Details:"));
    expect(run.steps).toContainEqual(
      expect.objectContaining({ step: "warning:finalize:doctor:0", status: "completed" }),
    );
    expect(run.steps.some((step) => step.status === "failed")).toBe(false);
    expect(getUpdateRun(old.runId)).toEqual(history);
    expect(readDeferredPluginMigrations()).toEqual([pending]);
    expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
    expect(plugins.updatePluginsAfterCoreUpdate).not.toHaveBeenCalled();
  },
);

it("reports retained update custody beside deferred Doctor maintenance", async () => {
  const retained = {
    nextAction: "Cancelled update custody still blocks the next update.",
    retainedUpdateCustody: {
      key: native.root,
      owner: "original-owner",
      leaseVersion: 4,
      lastActivityAt: "2026-10-17T01:52:32.724Z",
      reason: "Synthetic retained custody",
    },
  };

  await expect(updateFinalizeCommand(repairOptions, [], undefined, retained)).rejects.toEqual(
    new ExitError(2),
  );

  expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      status: "warning",
      nextAction: expect.stringMatching(
        /gateway stop --force.*update repair.*Cancelled update custody still blocks/u,
      ),
      retainedUpdateCustody: retained.retainedUpdateCustody,
    }),
  );
});

it.each(["coordinator-contention", "admission-unavailable"] as const)(
  "keeps deferred finalization successful for an inherited update driver (%s)",
  async (reason) => {
    const run = createUpdateRun({ trigger: "cli" });
    adoptUpdateRun(run.runId);
    vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
    vi.mocked(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
      new DoctorMaintenanceRefusalError("Synthetic maintenance contention", {
        kind: "deferred",
        reason,
      }),
    );

    await expect(updateFinalizeCommand(repairOptions)).resolves.toBeUndefined();

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warning",
        coreUpdate: "pending",
        nextAction: expect.stringContaining("openclaw update repair"),
        postUpdate: { doctor: { status: "warning", warnings: expect.any(Array) } },
      }),
    );
    expect(verifyUpdateFailureRecovery).not.toHaveBeenCalled();
    expect(getUpdateRun(run.runId)?.verification.rollbackOutcome).toBeUndefined();
    expect(getUpdateRun(run.runId)?.status).toBe("running");
    expect(readDeferredPluginMigrations()).toEqual([pending]);
    expect(plugins.updatePluginsAfterCoreUpdate).not.toHaveBeenCalled();
  },
);

it.each([
  "inside-gateway-process-tree",
  "inside-triage-process-tree",
  "service-definition-changed",
])("retains the managed-service refusal through repair history and reports (%s)", async (code) => {
  native.blockCode = code;
  await expect(updateRepairCommand({ json: true, yes: true })).rejects.toMatchObject({
    failureFacts: [{ check: "managed-service", code }],
  });
  const run = listUpdateRuns()[0]!;
  expect(run).toMatchObject({ status: "failed", reason: code });
  expect(run.steps).toContainEqual(
    expect.objectContaining({
      step: "update",
      failureFacts: [{ check: "managed-service", code }],
      exitCode: 1,
    }),
  );
  if (code !== "service-definition-changed") {
    expect(renderUpdateRunReport(run).markdown).toContain("terminal outside");
    expect(renderUpdateRunReport(run).markdown).toContain("openclaw update repair");
    expect(renderUpdateRunReport(run).markdown).not.toContain("Run openclaw triage");
  }
  expect(native.events).toEqual(["running-holder"]);
  expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
  expect(plugins.updatePluginsAfterCoreUpdate).not.toHaveBeenCalled();
});

it.each([
  ["doctor", false],
  ["source", false],
  ["source", true],
] as const)(
  "preserves the repair failure and recovery policy at %s (inherited=%s)",
  async (stage, inherited) => {
    if (inherited) {
      const run = createUpdateRun({ trigger: "cli" });
      adoptUpdateRun(run.runId);
      vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", run.runId);
    }
    const failure = new Error("Synthetic repair failure");
    if (stage === "doctor") {
      native.contend = false;
    }
    let inspect: MockInstance<typeof ports.inspectPortUsage> | undefined;
    let sleep: MockInstance<typeof utils.sleep> | undefined;
    if (stage === "source") {
      const actual = await vi.importActual<typeof import("./update-command-failure-recovery.js")>(
        "./update-command-failure-recovery.js",
      );
      vi.mocked(verifyUpdateFailureRecovery).mockImplementationOnce(
        actual.verifyUpdateFailureRecovery,
      );
      vi.mocked(updateCheck.resolveUpdateInstallKind).mockResolvedValue("git");
      vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockRejectedValueOnce(failure);
      vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate").mockResolvedValue(null);
      const health = await vi.importActual<typeof import("../daemon-cli/restart-health.js")>(
        "../daemon-cli/restart-health.js",
      );
      vi.spyOn(restartHealth, "waitForGatewayHealthyRestart").mockImplementationOnce(
        health.waitForGatewayHealthyRestart,
      );
      inspect = vi
        .spyOn(ports, "inspectPortUsage")
        .mockImplementation(async (port) => ({ port, status: "free", listeners: [], hints: [] }));
      sleep = vi.spyOn(utils, "sleep").mockImplementation(async () => {
        throw new Error("No Gateway startup was requested before the source repair refusal");
      });
    } else {
      vi.mocked(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
        failure,
      );
    }
    await expect(updateRepairCommand({ json: true, yes: true })).rejects.toBe(failure);
    const run = listUpdateRuns()[0]!;
    expect(run.status).toBe(inherited ? "running" : "failed");
    if (!inherited) {
      expect(run.reason).toBe("repair-failed");
    }
    if (stage === "source") {
      const reason = inherited ? "update-failed" : "repair-failed";
      expect(verifyUpdateFailureRecovery).toHaveBeenLastCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ reason }) }),
      );
      if (!inherited) {
        expect(renderUpdateRunReport(run).headline).toBe(
          "⚠️ OpenClaw repair failed: repair-failed.",
        );
        expect(renderUpdateRunReport(run).markdown).toContain("diagnose this repair failure");
      }
      expect(native.inspecting).toBe(false);
      expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
      expect(inspect).toHaveBeenCalledExactlyOnceWith(19483, expect.anything());
      expect(sleep).not.toHaveBeenCalled();
    } else {
      expect(readDeferredPluginMigrations()).toEqual([pending]);
      expect(native.events).toEqual([
        "running-holder",
        "stop-verified",
        "restart",
        "restart-verified",
      ]);
      expect(verifyUpdateFailureRecovery).toHaveBeenLastCalledWith(
        expect.objectContaining({ waitForStartup: true }),
      );
    }
  },
);

it.each([false, true])(
  "parks the managed Gateway before repairing source artifacts (stop refusal=%s)",
  async (failStop) => {
    native.contend = false;
    native.blockCode = failStop ? "self-service-stop" : undefined;
    const maintenance = vi.spyOn(doctorMaintenance, "beginDoctorMaintenance");
    let runtimeStartedAt = 0;
    let runtimeTimeoutMs = 0;
    vi.mocked(updateCheck.resolveUpdateInstallKind).mockResolvedValue("git");
    const afterPublication = new Error("Synthetic Doctor failure after runtime publication");
    vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockImplementationOnce(
      async ({ beforePublication, timeoutMs }) => {
        runtimeStartedAt = Date.now();
        runtimeTimeoutMs = timeoutMs;
        await beforePublication?.();
        if (!native.stopped) {
          throw new Error("Runtime artifacts require an offline Gateway");
        }
        native.events.push("publish");
        return { changed: true };
      },
    );
    vi.mocked(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
      afterPublication,
    );

    await expect(
      updateRepairCommand({ json: true, yes: true, deferCompletionCache: true, timeout: "3600" }),
    ).rejects.toThrow(
      failStop
        ? "Synthetic managed-service refusal before stopping the Gateway."
        : afterPublication.message,
    );
    expect(native.events).toEqual(
      failStop
        ? ["running-holder"]
        : ["running-holder", "stop-verified", "publish", "restart", "restart-verified"],
    );
    expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).toHaveBeenCalledTimes(
      failStop ? 0 : 1,
    );
    expect(maintenance).toHaveBeenCalledTimes(1);
    const inspectionDeadline = maintenance.mock.calls[0]?.[0].serviceInspectionDeadlineAtMs;
    expect(inspectionDeadline).toBeGreaterThan(runtimeStartedAt);
    expect(inspectionDeadline).toBeLessThanOrEqual(runtimeStartedAt + runtimeTimeoutMs);
  },
);
