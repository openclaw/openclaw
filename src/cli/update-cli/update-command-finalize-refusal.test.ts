import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GatewayServiceStopUnsafeError } from "../../daemon/service-inspection-error.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../../infra/deferred-plugin-migrations.js";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../../infra/gateway-shutdown-budget.js";
import * as updateCheck from "../../infra/update-check.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as shared from "./shared.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import { validConfigSnapshot } from "./update-command-lifecycle.test-support.js";
import * as plugins from "./update-command-plugins.js";
import { updateRepairCommand } from "./update-repair-command.js";

const native = vi.hoisted(() => ({
  events: [] as string[],
  inspecting: false,
  stopped: false,
  failStop: false,
  contend: true,
  elapsedMs: 0,
  root: "",
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
vi.mock("../../infra/state-database-coordinator.js", async (original) => {
  const actual = await original<typeof import("../../infra/state-database-coordinator.js")>();
  return {
    ...actual,
    acquireGatewayMaintenanceCoordinator: (
      params: Parameters<typeof actual.acquireGatewayMaintenanceCoordinator>[0],
    ) => {
      if (native.inspecting && (!native.stopped || native.contend)) {
        native.events.push(native.stopped ? "non-serving-holder" : "running-holder");
        throw new actual.StateDatabaseCoordinatorContentionError("gateway-lifecycle");
      }
      return actual.acquireGatewayMaintenanceCoordinator(params);
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
vi.mock("../daemon-cli/restart-health.js", () => ({
  waitForGatewayHealthyRestart: async () => {
    native.events.push("restart-verified");
    return { healthy: !native.stopped };
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
  verifyUpdateFailureRecovery: async (params: { result: unknown }) => params.result,
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

it.each([undefined, false])(
  "restores a stopped service and defers non-serving contention (restart=%s)",
  async (restart) => {
    const old = createUpdateRun({ trigger: "cli" });
    const history = finishUpdateRun(old.runId, { status: "failed", reason: "abandoned" });
    await updateRepairCommand({ json: true, yes: true, restart, deferCompletionCache: true });
    expect(native.events).toEqual([
      "running-holder",
      "stop-verified",
      "non-serving-holder",
      "non-serving-holder",
      "restart",
      "restart-verified",
    ]);
    expect(native.elapsedMs).toBe(GATEWAY_SERVICE_STOP_TIMEOUT_MS);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "warning",
        postUpdate: {
          doctor: {
            status: "warning",
            warnings: [expect.stringContaining("openclaw update repair")],
          },
        },
      }),
    );
    const run = listUpdateRuns()[0]!;
    expect(run.status).toBe("succeeded");
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

it("keeps a refused stop for an admitted migration write as a failed update", async () => {
  native.failStop = true;
  await expect(updateRepairCommand({ json: true, yes: true })).rejects.toThrow(
    "An admitted migration write is incomplete.",
  );
  expect(native.events).toEqual(["running-holder"]);
  expect(listUpdateRuns()[0]?.status).toBe("failed");
  expect(readDeferredPluginMigrations()).toEqual([pending]);
});

it("does not downgrade an error after Doctor has begun its schema write", async () => {
  native.contend = false;
  const partial = new Error("Synthetic half-applied schema write");
  vi.mocked(freshDoctor.runUpdateFinalizationDoctorInFreshProcess).mockRejectedValueOnce(partial);
  await expect(updateRepairCommand({ json: true, yes: true })).rejects.toBe(partial);
  expect(native.events).toEqual(["running-holder", "stop-verified", "restart", "restart-verified"]);
  expect(listUpdateRuns()[0]?.status).toBe("failed");
  expect(readDeferredPluginMigrations()).toEqual([pending]);
});
