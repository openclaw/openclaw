import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as daemonExec from "../../daemon/exec-file.js";
import * as gatewayService from "../../daemon/service.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  createMockGatewayService,
} from "../../daemon/service.test-helpers.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdUnitPath,
} from "../../daemon/systemd-service-files.js";
import { systemdManagerVersionProbe } from "../../daemon/systemd-user-bus.test-support.js";
import * as updateCheck from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { snapshotUpdateFixtureTree } from "./update-command-filesystem-snapshot.test-support.js";
import { admitUpdateCommandRun } from "./update-command-run.js";
import { stubNodeRuntime } from "./update-command-runtime-recovery.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { collectServiceInspectionFailureFacts } from "./update-command-service-plan.js";
import * as servicePlan from "./update-command-service-plan.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function createCommandResult(
  overrides: Partial<Awaited<ReturnType<typeof systemdExec.execBusctlUser>>> = {},
) {
  return { code: 0, termination: "exit" as const, stdout: "", stderr: "", ...overrides };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([
  "owned",
  "owned-pending",
  "stale-install",
  "absent",
  "unloaded-local",
  "timeout",
  "unresolved-root",
  "native-rejection",
  "root-probe-error",
] as const)(
  "preserves verified ownership and warns on unavailable inspection (%s)",
  async (scenario) => {
    stubNodeRuntime();
    const home = dirs.make("update-loaded-admission-");
    const callerState = path.join(home, ".openclaw-caller");
    const serviceState = path.join(home, ".openclaw-service");
    const profileEnv = (profile: "caller" | "service", state: string) => ({
      OPENCLAW_PROFILE: profile,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    });
    const callerOverrides = profileEnv("caller", callerState);
    const serviceOverrides = profileEnv("service", serviceState);
    const root = path.join(home, "package");
    const foreignRoot = path.join(home, "foreign");
    for (const packageRoot of [root, foreignRoot]) {
      fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      fs.writeFileSync(path.join(packageRoot, "dist", "entry.js"), "// fixture");
    }
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
    for (const key of [
      "OPENCLAW_HOME",
      "OPENCLAW_SYSTEMD_UNIT",
      "OPENCLAW_LAUNCHD_LABEL",
      "OPENCLAW_WINDOWS_TASK_NAME",
      "OPENCLAW_SUPERVISOR_MODE",
      UPDATE_RUN_ID_ENV,
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("HOME", home);
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", `unix:path=${path.join(home, "bus")}`);
    vi.spyOn(daemonExec, "execFileUtf8").mockImplementation(systemdManagerVersionProbe);
    for (const [key, value] of Object.entries(callerOverrides)) {
      vi.stubEnv(key, value);
    }
    const serviceEnv = { ...process.env, ...serviceOverrides };
    let pending: ReturnType<typeof createRetainedUpdateRecovery> | undefined;
    if (scenario === "owned-pending") {
      const runId = createUpdateRun({ trigger: "cli" }, { env: serviceEnv }).runId;
      const from = { root, nodePath: process.execPath, version: "1.0.0", buildId: null };
      pending = createRetainedUpdateRecovery(
        { runId, from, to: { ...from, version: "2.0.0" } },
        { env: serviceEnv },
      );
      closeOpenClawStateDatabaseForTest();
    }
    const sourcePath = resolveSystemdUnitPath(process.env);
    if (scenario === "unloaded-local") {
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(
        sourcePath,
        `[Service]\nExecStart=${process.execPath} ${root}/dist/entry.js gateway\n`,
      );
    }
    const snapshot = () => snapshotUpdateFixtureTree(home);
    const before = snapshot();
    const nativeFailure = new Error("inspection-secret-canary");
    const rootFailure = new Error("installation classification failed");
    if (scenario === "root-probe-error") {
      vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockRejectedValue(rootFailure);
    }
    const command =
      scenario === "unresolved-root"
        ? ["opaque-launcher"]
        : [
            process.execPath,
            path.join(scenario === "stale-install" ? foreignRoot : root, "dist", "entry.js"),
            "gateway",
          ];
    const bus = vi.spyOn(systemdExec, "execBusctlUser").mockImplementation(async (_env, args) => {
      if (scenario === "timeout") {
        return createCommandResult({
          code: 1,
          termination: "timeout",
          stderr: "inspection timed out",
        });
      }
      if (scenario === "absent" || scenario === "unloaded-local") {
        const unit = "openclaw-gateway-caller.service";
        return createCommandResult({
          code: 1,
          stderr: args.includes("GetUnitFileState")
            ? `Call failed: Unit file ${unit} does not exist.`
            : `Call failed: Unit ${unit} ${args.includes("GetUnit") ? "not loaded" : "not found"}.`,
        });
      }
      return createCommandResult({
        stdout:
          args.includes("GetUnit") || args.includes("LoadUnit")
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/gateway"] })
            : args.includes("FragmentPath")
              ? buildSystemdUnitPropertyOutput({ fragmentPath: sourcePath })
              : buildSystemdManagerPropertyOutput({
                  programArguments: command,
                  environment: Object.entries(serviceOverrides).map(
                    ([key, value]) => `${key}=${value}`,
                  ),
                }),
      });
    });
    if (scenario === "native-rejection") {
      bus.mockRejectedValue(nativeFailure);
    }
    // Keep the real command reader with independently verified native runtime facts.
    const service = createMockGatewayService({
      isLoaded: async () => true,
      readRuntime: async () => ({ status: "running", systemd: { managerUid: 2001 } }),
    });
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
      ...service,
      readCommand: (...args) => readSystemdServiceExecStart(...args),
    });
    const expectAdmitted = async (usesServiceState: boolean) => {
      const run = await admitUpdateCommandRun({ opts: {}, root });
      expect(run.env).toMatchObject(usesServiceState ? serviceOverrides : callerOverrides);
      expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    };
    if (scenario === "owned" || scenario === "stale-install" || scenario === "absent") {
      const usesServiceState = scenario !== "absent";
      await expectAdmitted(usesServiceState);
      expect(fs.existsSync(path.join(usesServiceState ? callerState : serviceState, "state"))).toBe(
        false,
      );
    } else if (scenario === "owned-pending" || scenario === "root-probe-error") {
      const admission = admitUpdateCommandRun({ opts: {}, root });
      if (pending) {
        await expect(admission).rejects.toBeInstanceOf(UpdateRecoveryRequiredError);
        expect(loadUpdateRecovery(pending.runId, { env: serviceEnv })).toEqual(pending);
      } else {
        await expect(admission).rejects.toBe(rootFailure);
      }
      expect(snapshot()).toEqual(before);
    } else {
      expect(await servicePlan.resolveManagedServicePackageUpdatePlan({ root })).toEqual({
        rootRedirect: null,
        serviceUnitTarget: "no service entrypoint found",
      });
      await expectAdmitted(false);
      expect(fs.existsSync(serviceState)).toBe(false);

      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        phase: "inspect",
      });
      expect(inspected.serviceUpdateVerdict).toMatchObject({
        kind: "unavailable",
        message: expect.stringContaining("Gateway service inspection is unavailable"),
      });
      expect([
        inspected.blockMessage,
        inspected.serviceMutationAllowed,
        inspected.stopped,
        inspected.serviceEnv,
        inspected.serviceDefinitionEnv,
        inspected.serviceNodeRunner,
      ]).toEqual([undefined, false, false, undefined, undefined, undefined]);
      const advisory = inspected.serviceMutationSkipMessage;
      expect(advisory).toContain("automatic service restart was skipped");
      expect(advisory).toContain("Restart the Gateway you launched manually after the update");
      expect(advisory).toContain("recorded service definition was left unchanged");
      expect(advisory).toContain("openclaw gateway status --deep");
      const facts = collectServiceInspectionFailureFacts(inspected.serviceUpdateVerdict);
      expect(facts).toEqual([
        expect.objectContaining({
          check: "managed-service",
          code:
            scenario === "timeout"
              ? "systemd-inspection-deadline-exceeded"
              : "service-inspection-unavailable",
          message: expect.stringContaining(
            scenario === "timeout"
              ? "The systemd manager inspection deadline expired"
              : "Restart the Gateway you launched manually",
          ),
        }),
      ]);
      expect(JSON.stringify({ inspected, facts })).not.toContain("inspection-secret-canary");
      expect(
        snapshot().filter(
          ([name]) => name !== ".openclaw-caller" && !String(name).startsWith(".openclaw-caller/"),
        ),
      ).toEqual(before);
    }
    for (const method of ["stage", "install", "uninstall", "start", "stop", "restart"] as const) {
      expect(service[method]).not.toHaveBeenCalled();
    }
    if (scenario === "root-probe-error") {
      expect(bus).not.toHaveBeenCalled();
    } else {
      expect(bus).toHaveBeenCalled();
    }
    expect(bus.mock.calls.every(([, args]) => !args.includes("LoadUnit"))).toBe(true);
  },
);
