import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GatewayServiceStopUnsafeError } from "../../daemon/service-inspection-error.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../../infra/deferred-plugin-migrations.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import * as ports from "../../infra/ports-inspect.js";
import * as updateCheck from "../../infra/update-check.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import {
  adoptUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as utils from "../../utils.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import * as shared from "./shared.js";
import { verifyUpdateFailureRecovery } from "./update-command-failure-recovery.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import { validConfigSnapshot } from "./update-command-lifecycle.test-support.js";
import * as plugins from "./update-command-plugins.js";
import * as sourceRuntime from "./update-command-runtime.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateRepairCommand } from "./update-repair-command.js";

const native = vi.hoisted(() => ({
  events: [] as string[],
  inspecting: false,
  stopped: false,
  failStop: false,
  contend: true,
  elapsedMs: 0,
  root: "",
  absent: false,
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
      if (!native.absent && native.inspecting && (!native.stopped || native.contend)) {
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
    maybeStopManagedServiceBeforeMutableUpdate: async (params: {
      phase?: string;
      onStopped?: (before: unknown) => void;
    }) => {
      native.inspecting = true;
      if (native.absent) {
        return {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: false,
          serviceMutationAllowed: false,
          serviceUpdateVerdict: { kind: "absent" },
        };
      }
      if (params.phase !== "inspect") {
        if (native.failStop) {
          throw new GatewayServiceStopUnsafeError("An admitted migration write is incomplete.");
        }
        native.stopped = true;
        // A verified stop can consume the shutdown allowance before ownership clears.
        native.elapsedMs += GATEWAY_SERVICE_STOP_TIMEOUT_MS;
        native.events.push("stop-verified");
      }
      const before = {
        stopped: native.stopped,
        inspected: true,
        runtimeInspected: true,
        running: !native.stopped,
        offline: native.stopped,
        serviceEnv: { ...process.env },
        serviceUpdateVerdict: { kind: "owned", root: native.root, refreshDefinition: false },
      };
      if (native.stopped) {
        params.onStopped?.(before);
      }
      return before;
    },
    revalidateManagedGatewayServiceAfterUpdate: async () => ({ kind: "owned", root: native.root }),
  };
});
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    readCommand: async () => null,
    readRuntime: async () => ({ status: "stopped", missingUnit: true }),
    isLoaded: async () => false,
    restart: async () => {
      native.events.push("restart");
      native.stopped = false;
    },
  }),
  readGatewayServiceState: async () => ({
    env: { ...process.env },
    command: null,
    loadState: { status: "loaded" },
    runtime: { status: "stopped" },
  }),
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

beforeEach(async () => {
  const base = dirs.make("finalize-refusal-");
  native.root = path.join(base, "package");
  native.absent = false;
  await fs.mkdir(native.root);
  await fs.writeFile(
    path.join(native.root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
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
  native.failStop = false;
  native.contend = true;
  native.elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => native.elapsedMs);
  await recordDeferredPluginMigrations({ pending: [pending] });
  vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(native.root);
  vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
  vi.spyOn(freshDoctor, "runUpdateFinalizationDoctorInFreshProcess").mockResolvedValue(undefined);
  vi.spyOn(plugins, "updatePluginsAfterCoreUpdate");
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "restores a stopped service and reports pending repair (json=%s)",
  async (json) => {
    vi.stubEnv("OPENCLAW_PROFILE", "repair-test");
    const nextAction =
      "Stop the Gateway through its service owner, stop other OpenClaw processes using this state, then rerun `openclaw --profile repair-test update repair`.";
    const old = createUpdateRun({ trigger: "cli" });
    const history = finishUpdateRun(old.runId, { status: "failed", reason: "abandoned" });
    await updateRepairCommand({ json, yes: true, deferCompletionCache: true });
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
              warnings: [expect.stringContaining("update repair")],
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

it.each([
  ["stop", false],
  ["doctor", false],
  ["headless", false],
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
    const failure =
      stage === "stop"
        ? new GatewayServiceStopUnsafeError("An admitted migration write is incomplete.")
        : new Error(
            stage === "doctor"
              ? "Synthetic half-applied schema write"
              : stage === "headless"
                ? "Synthetic repair failed"
                : "Synthetic runtime artifact ownership refusal",
          );
    native.failStop = stage === "stop";
    native.absent = stage === "headless";
    if (stage === "doctor") {
      native.contend = false;
    }
    if (stage === "headless" || stage === "source") {
      const actual = await vi.importActual<typeof import("./update-command-failure-recovery.js")>(
        "./update-command-failure-recovery.js",
      );
      vi.mocked(verifyUpdateFailureRecovery).mockImplementationOnce(
        actual.verifyUpdateFailureRecovery,
      );
    }
    let inspect: MockInstance<typeof ports.inspectPortUsage> | undefined;
    let sleep: MockInstance<typeof utils.sleep> | undefined;
    if (stage === "source") {
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
    } else if (stage !== "stop") {
      vi.mocked(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(
        failure,
      );
    }
    const operation = expect(updateRepairCommand({ json: true, yes: true })).rejects;
    if (stage === "stop") {
      await operation.toThrow(failure.message);
    } else {
      await operation.toBe(failure);
    }
    const run = listUpdateRuns()[0]!;
    expect(run.status).toBe(inherited ? "running" : "failed");
    if (!inherited && stage !== "stop") {
      expect(run.reason).toBe("repair-failed");
    }
    if (stage === "source") {
      const reason = inherited ? "update-failed" : "repair-failed";
      expect(verifyUpdateFailureRecovery).toHaveBeenLastCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ reason }) }),
      );
      if (!inherited) {
        expect(run.reason).toBe(reason);
        expect(renderUpdateRunReport(run).headline).toBe(
          "⚠️ OpenClaw repair failed: repair-failed.",
        );
        expect(renderUpdateRunReport(run).markdown).toContain("diagnose this repair failure");
        const report = await prepareUpdateFailureReport({
          attemptId: run.runId,
          recordedRun: run,
          result: { status: "error", mode: "unknown", steps: [], durationMs: 1 },
        });
        expect(report.body).toContain("Reason code: repair-failed");
        expect(report.body).not.toContain("Reason code: update-failed");
      }
      expect(native.inspecting).toBe(false);
      expect(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).not.toHaveBeenCalled();
      expect(inspect).toHaveBeenCalledExactlyOnceWith(19483, expect.anything());
      expect(sleep).not.toHaveBeenCalled();
    } else {
      expect(readDeferredPluginMigrations()).toEqual([pending]);
      expect(native.events).toEqual(
        stage === "stop"
          ? ["running-holder"]
          : stage === "doctor"
            ? ["running-holder", "stop-verified", "restart", "restart-verified"]
            : [],
      );
      if (stage === "doctor") {
        expect(verifyUpdateFailureRecovery).toHaveBeenLastCalledWith(
          expect.objectContaining({ waitForStartup: true }),
        );
      } else if (stage === "headless") {
        expect(run.steps).toContainEqual(
          expect.objectContaining({
            step: "diagnostic:gateway recovery observation",
            detail: expect.stringContaining("no Gateway service or listener"),
          }),
        );
        expect(run.verification.readyz).not.toBe(true);
      }
    }
  },
);
