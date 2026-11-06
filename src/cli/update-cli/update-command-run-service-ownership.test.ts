import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { parseUpdateRecoveryBackupManifest } from "../../commands/backup-verify-manifest.js";
import * as daemonExec from "../../daemon/exec-file.js";
import { ServiceInspectionError } from "../../daemon/service-inspection-error.js";
import * as gatewayService from "../../daemon/service.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdUnitPath,
} from "../../daemon/systemd-service-files.js";
import { systemdManagerVersionProbe } from "../../daemon/systemd-user-bus.test-support.js";
import * as databaseEngine from "../../infra/database-engine/config.js";
import { writePackageRoot } from "../../infra/package-update-steps.test-support.js";
import * as ports from "../../infra/ports-probe.js";
import * as updateCheck from "../../infra/update-check.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import * as baselineCapture from "../../infra/update-recovery-baseline-capture.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import * as updateRunLedger from "../../infra/update-run-ledger.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import * as shared from "./shared.js";
import { snapshotUpdateFixtureTree } from "./update-command-filesystem-snapshot.test-support.js";
import * as commandRun from "./update-command-run.js";
import {
  admitUpdateCommandRun,
  prepareUpdateCommand,
  resolveUpdateCommandAdmissionEnv,
  resolveUpdateCommandAdmissionRoot,
} from "./update-command-run.js";
import {
  getNodeRuntimeFixture,
  stubNodeRuntime,
} from "./update-command-runtime-recovery.test-support.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";
import { collectServiceInspectionFailureFacts } from "./update-command-service-plan.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

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

function admissionHome(prefix: string) {
  const home = dirs.make(prefix);
  const callerState = path.join(home, ".openclaw-caller");
  const serviceState = path.join(home, ".openclaw-service");
  const profileEnv = (profile: string, state: string) => ({
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  });
  const callerOverrides = profileEnv("caller", callerState);
  const serviceOverrides = profileEnv("service", serviceState);
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
  for (const [key, value] of Object.entries({ HOME: home, ...callerOverrides })) {
    vi.stubEnv(key, value);
  }
  return { home, callerState, serviceState, callerOverrides, serviceOverrides };
}

it.each([
  "owned",
  "owned-command",
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
    const serviceNode = getNodeRuntimeFixture().execPath;
    const { home, callerState, serviceState, callerOverrides, serviceOverrides } = admissionHome(
      "update-loaded-admission-",
    );
    const root = path.join(home, "package");
    const foreignRoot = path.join(home, "foreign");
    for (const packageRoot of [root, foreignRoot]) {
      fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), '{"name":"openclaw"}');
      fs.writeFileSync(path.join(packageRoot, "dist", "entry.js"), "// fixture");
    }
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", `unix:path=${path.join(home, "bus")}`);
    vi.spyOn(daemonExec, "execFileUtf8").mockImplementation(systemdManagerVersionProbe);
    const serviceEnv = { ...process.env, ...serviceOverrides };
    let previousRunId: string | undefined;
    if (scenario === "owned-command") {
      await writePackageRoot(root, "1.0.0");
      for (const [state, channel] of [
        [callerState, "stable"],
        [serviceState, "beta"],
      ] as const) {
        fs.mkdirSync(state, { mode: 0o700 });
        fs.writeFileSync(
          path.join(state, "openclaw.json"),
          JSON.stringify({ update: { channel }, database: { engine: "sqlite" } }),
        );
      }
      previousRunId = createUpdateRun({ trigger: "cli" }, { env: serviceEnv }).runId;
      updateRunLedger.finishUpdateRun(previousRunId, { status: "succeeded" }, { env: serviceEnv });
      closeOpenClawStateDatabaseForTest();
      using original = new DatabaseSync(resolveOpenClawStateSqlitePath(serviceEnv));
      original
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("fixture.original", '{"selected":"service"}', 1);
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
    }
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
        `[Service]\nExecStart=${serviceNode} ${root}/dist/entry.js gateway\n`,
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
            serviceNode,
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
      const env = await resolveUpdateCommandAdmissionEnv({ opts: {}, root });
      const run = await admitUpdateCommandRun({ opts: {}, root, env });
      expect(run.env).toMatchObject(usesServiceState ? serviceOverrides : callerOverrides);
      expect(getUpdateRun(run.runId, { env: run.env })?.status).toBe("running");
    };
    if (scenario === "owned-command") {
      const resolve = vi.spyOn(commandRun, "resolveUpdateCommandAdmissionEnv");
      const admission = vi.spyOn(commandRun, "admitUpdateCommandRun");
      const engine = vi.spyOn(databaseEngine, "resolveDatabaseEngineSelection");
      const capture = vi.spyOn(baselineCapture, "captureUpdateRecoveryBaseline");
      const inspection = vi.spyOn(servicePlan, "readManagedGatewayServiceForUpdate");
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      await expect(
        updateCommand({ tag: "main", yes: true, json: true, restart: false }),
      ).rejects.toEqual(new ExitError(1));
      expect(resolve).toHaveBeenCalledOnce();
      expect(admission).toHaveBeenCalledOnce();
      const selectedEnv = await resolve.mock.results[0]!.value;
      const run = await admission.mock.results[0]!.value;
      expect(selectedEnv).toMatchObject(serviceOverrides);
      expect(admission.mock.calls[0]?.[0].env).toBe(selectedEnv);
      expect(run.env).toBe(selectedEnv);
      expect(engine).toHaveBeenCalledWith(
        expect.objectContaining({ update: { channel: "beta" }, database: { engine: "sqlite" } }),
        expect.objectContaining(serviceOverrides),
      );
      expect(capture).toHaveBeenCalledOnce();
      expect(capture.mock.calls[0]?.[0].env).toBe(selectedEnv);
      expect(
        inspection.mock.calls.filter(
          ([, selectedRoot, allowInstallRootChange]) =>
            selectedRoot === root && allowInstallRootChange === true,
        ),
      ).toHaveLength(1);
      expect(getUpdateRun(run.runId, { env: serviceEnv })).toMatchObject({
        status: "failed",
        phase: "finished",
        reason: "unsupported-package-target",
      });
      expect(
        fs.existsSync(resolveOpenClawStateSqlitePath({ ...process.env, ...callerOverrides })),
      ).toBe(false);
      expect(output).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.runId, reason: "unsupported-package-target" }),
      );
      const ref = run.originalRecoveryCapture;
      assert(ref);
      const manifest = parseUpdateRecoveryBackupManifest(fs.readFileSync(ref.manifestPath, "utf8"));
      const databasePath = fs.realpathSync(resolveOpenClawStateSqlitePath(serviceEnv));
      expect(manifest.databases).toContainEqual({ role: "global", path: databasePath });
      const captured = manifest.entries.find((entry) => entry.sourcePath === databasePath);
      assert(captured?.kind === "file");
      using original = new DatabaseSync(
        path.join(path.dirname(ref.manifestPath), captured.archivePath),
        { readOnly: true },
      );
      expect(
        original
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("fixture.original"),
      ).toEqual({ value_json: '{"selected":"service"}' });
      expect(original.prepare("SELECT run_id FROM update_runs ORDER BY run_id").all()).toEqual([
        { run_id: previousRunId },
      ]);
    } else if (scenario === "owned" || scenario === "stale-install" || scenario === "absent") {
      const usesServiceState = scenario !== "absent";
      await expectAdmitted(usesServiceState);
      expect(fs.existsSync(path.join(usesServiceState ? callerState : serviceState, "state"))).toBe(
        false,
      );
    } else if (scenario === "owned-pending" || scenario === "root-probe-error") {
      const admission = resolveUpdateCommandAdmissionEnv({ opts: {}, root }).then((env) =>
        admitUpdateCommandRun({ opts: {}, root, env }),
      );
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
      expect(advisory).toContain("openclaw --profile caller gateway stop");
      expect(advisory).toContain("openclaw --profile caller update repair");
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
              : "Gateway service inspection is unavailable",
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

const unmask = "systemctl --user unmask openclaw-gateway.service";
const maskedRefusal = {
  reason: "masked" as const,
  message: `Service masked; run \`${unmask}\`, then retry.`,
};
it.each([
  { platform: "linux", outcome: "unavailable" },
  { platform: "linux", outcome: "conflict" },
  { platform: "linux", outcome: "masked" },
  { platform: "darwin", outcome: "conflict" },
  { platform: "darwin", outcome: "redirect" },
] as const)(
  "preserves service admission authority ($platform, $outcome)",
  async ({ platform, outcome }) => {
    stubNodeRuntime();
    // Platform simulation cannot host native reconciliation workers.
    vi.spyOn(updateRunLedger, "reconcileAbandonedUpdateRunsAsync").mockResolvedValue([]);
    const { home, callerState, serviceState, serviceOverrides } = admissionHome(
      "update-service-admission-",
    );
    const callerRoot = path.join(home, "caller-package");
    const serviceRoot = path.join(home, "service-package");
    await Promise.all([callerRoot, serviceRoot].map((root) => writePackageRoot(root, "1.0.0")));
    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE", undefined);
    if (outcome === "redirect") {
      openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: serviceState },
      });
      closeOpenClawStateDatabaseForTest();
    }
    mockProcessPlatform(platform);
    mockSystemAccountHome();
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(callerRoot);
    const native = createMockGatewayService({
      isLoaded: async () => {
        if (outcome === "unavailable") {
          throw new ServiceInspectionError("service-manager-unavailable");
        }
        return true;
      },
      readRuntime: async () =>
        outcome === "unavailable"
          ? { status: "unknown", inspectionReason: "service-manager-unavailable" }
          : {
              status: "running",
              systemd: {
                managerUid: 2001,
                ...(outcome === "masked" ? { startRefusal: maskedRefusal } : {}),
              },
            },
      readCommand: async () => ({
        programArguments: [process.execPath, path.join(serviceRoot, "dist", "index.js"), "gateway"],
        environment: {
          ...serviceOverrides,
          ...(outcome === "conflict"
            ? platform === "linux"
              ? { OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-other.service" }
              : { OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.other" }
            : {}),
        },
      }),
    });
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(native);
    if (outcome === "conflict" || outcome === "masked") {
      await expect(prepareUpdateCommand({ dryRun: true })).rejects.toBeInstanceOf(
        servicePlan.GatewayServiceUpdateOwnershipError,
      );
      const temporaryRoot = path.join(home, "reports");
      await fs.promises.mkdir(temporaryRoot);
      vi.spyOn(os, "tmpdir").mockReturnValue(temporaryRoot);
      const output = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exit = await updateCommand({ dryRun: outcome !== "masked", json: true }).catch(
        (error: unknown) => error,
      );
      expect(exit).toBeInstanceOf(ExitError);
      expect(exit).toMatchObject({ code: 1 });
      expect(output).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: "error",
          reason: "managed-service-preflight",
          reportPath: expect.any(String),
        }),
      );
      const { reportPath } = output.mock.calls[0]![0] as { reportPath: string };
      expect(path.dirname(path.dirname(reportPath))).toBe(temporaryRoot);
      if (outcome === "masked") {
        expect(JSON.stringify(output.mock.calls)).toContain(unmask);
      }
      expect(await fs.promises.readFile(reportPath, "utf8")).toContain("Bounded diagnostic JSON:");
      await expect(fs.promises.stat(callerState)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.promises.stat(serviceState)).rejects.toMatchObject({ code: "ENOENT" });
      expect(native.stop).not.toHaveBeenCalled();
      expect(native.install).not.toHaveBeenCalled();
      return;
    }
    const prepared = await prepareUpdateCommand({ dryRun: true });
    const root = resolveUpdateCommandAdmissionRoot(prepared);
    expect(prepared.discoveredRoot).toBe(callerRoot);
    expect(prepared.servicePlan?.rootRedirect).toBeNull();
    expect(prepared.servicePlan?.serviceRoot).toBe(
      outcome === "unavailable" ? undefined : serviceRoot,
    );
    const env = await resolveUpdateCommandAdmissionEnv({ root, opts: {} });
    expect(root).toBe(outcome === "unavailable" ? callerRoot : serviceRoot);
    expect(env.OPENCLAW_STATE_DIR).toBe(outcome === "unavailable" ? callerState : serviceState);
    const run = await admitUpdateCommandRun({ opts: {}, root, env });
    expect(run.env.OPENCLAW_STATE_DIR).toBe(env.OPENCLAW_STATE_DIR);
    if (outcome === "unavailable") {
      const inspected = await maybeStopManagedServiceBeforeMutableUpdate({
        root,
        updateInstallKind: "package",
        shouldRestart: true,
        phase: "inspect",
        jsonMode: true,
      });
      expect(inspected.serviceUpdateVerdict).toMatchObject({
        kind: "unavailable",
        inspectionReason: "service-manager-unavailable",
        message: expect.stringContaining("openclaw --profile caller gateway stop"),
      });
      expect(inspected.blockMessage).toBeUndefined();
      expect(inspected.serviceEnv).toBeUndefined();
      await expect(fs.promises.stat(serviceState)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(native.stop).not.toHaveBeenCalled();
    expect(native.install).not.toHaveBeenCalled();
  },
);

it.each(["owned", "foreign", "absent", "failed"] as const)(
  "selects a startup executable only from an admitted service (%s)",
  async (ownership) => {
    const { home } = admissionHome("update-startup-runtime-");
    mockProcessPlatform("darwin");
    mockSystemAccountHome();
    const root = path.join(home, "package");
    const serviceRoot = ownership === "foreign" ? path.join(home, "foreign") : root;
    await writePackageRoot(serviceRoot, "1.0.0");
    let executable = path.join(home, "runtime", "bun");
    vi.spyOn(ports, "probePortUsage").mockResolvedValue("free");
    const command = {
      programArguments: ["node", path.join(serviceRoot, "dist", "index.js"), "gateway"],
    };
    const service = createMockGatewayService({
      isLoaded: async () => ownership !== "absent",
      readCommand: async (_env, options) => {
        options?.onEffectiveExecutable?.(executable);
        if (ownership === "failed") {
          throw new Error("native inspection failed");
        }
        return ownership === "absent" ? null : command;
      },
      readRuntime: async () => ({ status: "stopped", missingUnit: ownership === "absent" }),
    });
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(service);
    const onOwnedStartupRuntime = vi.fn();

    const state = await maybeStopManagedServiceBeforeMutableUpdate({
      root,
      updateInstallKind: "git",
      shouldRestart: false,
      jsonMode: true,
      phase: "inspect",
      onOwnedStartupRuntime,
    });

    expect(state.serviceUpdateVerdict?.kind).toBe(
      ownership === "failed" ? "unavailable" : ownership,
    );
    if (ownership === "owned") {
      expect(onOwnedStartupRuntime).toHaveBeenCalledExactlyOnceWith(executable);
      executable = path.join(home, "other-runtime", "node");
      const observed = await gatewayService.readGatewayServiceState(service, { env: process.env });
      const reinspection = await servicePlan.inspectManagedGatewayServiceBeforeUpdate({
        root,
        state: observed,
      });
      expect(observed.effectiveExecutable).toBe(executable);
      expect(reinspection).toEqual(state.serviceUpdateVerdict);
    } else {
      expect(onOwnedStartupRuntime).not.toHaveBeenCalled();
    }
    expect(state).not.toHaveProperty("effectiveExecutable");
    expect(state).not.toHaveProperty("gatewayStartupRuntime");
    expect(command).toEqual({
      programArguments: ["node", path.join(serviceRoot, "dist", "index.js"), "gateway"],
    });
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.install).not.toHaveBeenCalled();
  },
);
