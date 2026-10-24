import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import * as stateSchemas from "../../infra/update-candidate-state.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome-classification.js";
import { writeOpenClawPackageFixture } from "./update-cli-package.test-support.js";
import { registerUnverifiedDefinitionRecoveryTests } from "./update-command-definition-recovery.test-support.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import { createPostUpdateRepairFixture } from "./update-command-post-update-repair.test-support.js";
import { registerCurrentCoreRuntimeRefreshTests } from "./update-command-post-update-runtime-refresh.test-support.js";
import { finishUpdate } from "./update-command-post-update.js";
import { successfulPluginUpdate, taskRecovery } from "./update-command-post-update.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

const { revalidateManagedGatewayServiceAfterUpdate } = await vi.importActual<
  typeof import("./update-command-service-revalidation.js")
>("./update-command-service-revalidation.js");

const mocks = vi.hoisted(() => ({
  rollback: vi.fn<typeof import("./update-command-rollback.js").rollbackFailedUpdate>(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  restartCommand:
    vi.fn<typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand>(),
  healthy: false,
  version: "2026.9.3",
  stop: vi.fn<
    typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
  >(),
  readyz: vi.fn(),
  print: vi.fn(),
  revalidate: vi.fn(),
  converge: vi.fn(),
  readService: vi.fn<typeof import("../../daemon/service.js").readGatewayServiceState>(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
// mock-isolation: Recovery tests mutate only their synthetic Windows task, never host services.
vi.mock("../../daemon/schtasks-exec.js", () => ({
  execSchtasks: mocks.execSchtasks,
  execScheduledTaskEnabledChange: (taskName: string, enabled: boolean) =>
    mocks.execSchtasks(["/Change", "/TN", taskName, enabled ? "/ENABLE" : "/DISABLE"]),
}));
vi.mock("./update-command-rollback.js", () => ({ rollbackFailedUpdate: mocks.rollback }));
vi.mock("./progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./progress.js")>()),
  printResult: mocks.print,
  prepareResult:
    async (...args: Parameters<typeof import("./progress.js").printResult>) =>
    () =>
      mocks.print(...args.slice(0, 3)),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  tryWriteCompletionCache: async () => {},
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({
    valid: true,
    exists: false,
    config: asRuntimeConfig({}),
    sourceConfig: asResolvedSourceConfig({}),
  }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../daemon/service.js")>();
  return {
    ...actual,
    readGatewayServiceState: mocks.readService,
    resolveGatewayService: vi.fn(actual.resolveGatewayService),
  };
});
vi.mock("../daemon-cli/restart-health-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health-probe.js")>()),
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  confirmGatewayReachable: async () => ({ reachable: false }),
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => {
  const readHealth = async ({ expectedVersion }: { expectedVersion?: string }) => ({
    gatewayBootId: "repair-boot",
    healthy: mocks.healthy && mocks.version === expectedVersion,
    runtime: { status: mocks.healthy ? "running" : "stopped", pid: 4321 },
    gatewayVersion: mocks.version,
    expectedVersion,
    versionMismatch: mocks.version !== expectedVersion,
    portUsage: { status: "free", listeners: [] },
    staleGatewayPids: [],
    waitOutcome: mocks.healthy ? "healthy" : "stopped-free",
  });
  return {
    ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
    waitForGatewayHealthyRestart: readHealth,
    inspectGatewayRestart: readHealth,
    waitForGatewayHttpReadiness: mocks.readyz,
  };
});
vi.mock("./update-command-service-revalidation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-revalidation.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidate,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  resolveUpdatedGatewayRestartPort: async () => 19101,
  tryInstallShellCompletion: async () => {},
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restartCommand,
}));
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: mocks.converge,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: async () => {},
  markControlPlaneUpdateRestartSentinelFailureBestEffort: async () => {},
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const fixture = (profile?: string) =>
  createPostUpdateRepairFixture(dirs.make("post-update-repair-"), profile);
const { objectContaining: partial } = expect;

function stoppedService(
  root: string,
  env: NodeJS.ProcessEnv,
  managerUid?: number,
): GatewayServiceState {
  return {
    installed: true,
    loadState: { status: "loaded" },
    running: false,
    runtime: {
      status: "stopped",
      ...(managerUid === undefined ? {} : { systemd: { managerUid } }),
    },
    env,
    command: { programArguments: ["node", path.join(root, "dist/entry.js"), "gateway"] },
  };
}

function expectNoInferredRepair() {
  expect(mocks.restartCommand).not.toHaveBeenCalled();
}

describe("post-activation failure settlement without inference", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      dirs.make("post-update-repair-native-"),
    );
    const actualService =
      await vi.importActual<typeof import("../../daemon/service.js")>("../../daemon/service.js");
    vi.mocked(resolveGatewayService)
      .mockReset()
      .mockImplementation((...args) => ({
        ...actualService.resolveGatewayService(...args),
        isLoaded: async () => false,
      }));
    const verification = await vi.importActual<typeof import("./update-command-verification.js")>(
      "./update-command-verification.js",
    );
    vi.mocked(verifyUpdatedGateway)
      .mockReset()
      .mockImplementation(verification.verifyUpdatedGateway);
    mocks.healthy = false;
    mocks.version = "2026.9.3";
    mocks.readService.mockResolvedValue(stoppedService("/candidate", process.env));
    mocks.converge.mockImplementation(async (params: { result: unknown }) => ({
      resultWithPostUpdate: params.result,
    }));
    mocks.revalidate.mockResolvedValue({
      kind: "owned",
      root: "/candidate",
      fingerprint: "fixture",
      refreshDefinition: false,
    });
    mocks.readyz.mockImplementation(async () => ({ readyz: mocks.healthy ? 200 : 503 }));
    mocks.rollback.mockImplementation(async ({ result, rollbackBlockedReason }) => ({
      result: { ...result, reason: rollbackBlockedReason ?? "source-rollback-failed" },
      rolledBack: false,
    }));
    mocks.restart.mockImplementation(async (params) => {
      params.onGatewayStartAttempted?.();
      if (!mocks.restart.mock.calls.slice(0, -1).length) {
        if (params.opts.run) {
          recordUpdateRunPhase(params.opts.run.runId, "verifying", undefined, {
            env: params.opts.run.env,
          });
        }
        params.onVerificationFailure?.("readyz-unhealthy");
        return "restart-health-failed";
      }
      return mocks.healthy ? "ok" : "restart-health-failed";
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  });

  it.each(["ok", "readiness-pending", "still-starting"] as const)(
    "records the bounded readiness outcome and retains only unverified backups (%s)",
    async (outcome) => {
      const ready = outcome === "ok";
      const reason = outcome === "still-starting" ? outcome : "gateway-readiness-unverified";
      const params = fixture();
      const run = params.opts.run!;
      const { transaction, packageRoot } = await createRetainedPackageSwap(
        dirs.make("update-readiness-pending-"),
      );
      params.root = packageRoot;
      params.result.root = packageRoot;
      params.packageTransaction = transaction;
      const windowsRecovery = taskRecovery();
      params.preManagedServiceStop!.windowsTaskAutoStartRecovery = windowsRecovery;
      params.preManagedServiceStop!.stoppedAtMs = Date.now() - 90_000;
      const observation =
        "Gateway readiness exceeded 90000ms; service running (PID 7376), waiting for Gateway listener. Gateway left starting.";
      mocks.restart.mockImplementationOnce(async ({ result, onVerified }) => {
        recordUpdateRunVerification(
          run.runId,
          {
            serviceRunning: true,
            pid: 7376,
            settled: ready,
            readyz: ready,
            channelsReady: ready,
            versionMatch: true,
            pluginErrors: [],
          },
          { env: run.env },
        );
        if (ready) {
          onVerified?.(Date.now());
          return "ok";
        }
        result.steps.push({
          name: "gateway verification",
          command: "gateway verification",
          cwd: packageRoot,
          durationMs: 90_000,
          exitCode: 0,
          termination: "timeout",
          advisory: { kind: "recoverable-maintenance", message: observation },
        });
        if (outcome === "still-starting") {
          result.reason = outcome;
        }
        return "readiness-pending";
      });

      const result = await finishUpdate(params);
      expect(result).toMatchObject(ready ? { status: "ok" } : { status: "skipped", reason });
      expect(classifyUpdateOutcome(result)).toBe(ready ? "succeeded" : "noop");
      expect(result.recovery).toBeUndefined();

      expect(mocks.rollback).not.toHaveBeenCalled();
      expectNoInferredRepair();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(windowsRecovery.complete).toHaveBeenCalledWith(true);
      if (ready) {
        await expect(fs.stat(transaction.backupRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(
          fs.readFile(path.join(transaction.backupRoot, "package.json"), "utf8"),
        ).resolves.toContain('"version":"1.0.0"');
      }
      await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
        '"version":"2.0.0"',
      );
      const recorded = getUpdateRun(run.runId, { env: run.env });
      expect(recorded).toMatchObject({
        status: ready ? "succeeded" : "skipped",
        reason: ready ? null : reason,
        confirmedAtMs: ready ? expect.any(Number) : null,
        downtimeMs: ready ? expect.any(Number) : null,
        verification: { serviceRunning: true, settled: ready, readyz: ready },
      });
      if (!ready) {
        expect(recorded?.steps).toContainEqual(
          partial({ step: "warning:gateway verification", detail: observation }),
        );
        expect(recorded?.origin.nextAction).not.toContain("Keep the gateway stopped");
        if (outcome === "still-starting" && recorded) {
          expect(renderUpdateRunReport(recorded).markdown).toContain("Gateway still starting");
        }
      }
    },
  );

  registerCurrentCoreRuntimeRefreshTests(fixture, mocks);

  registerUnverifiedDefinitionRecoveryTests({
    fixture,
    makeHome: () => dirs.make("update-definition-recovery-unverified-"),
    mocks,
  });

  it("records a skipped rollback when no previous package was retained", async () => {
    const params = fixture();
    const root = dirs.make("rollback-unavailable-");
    await writeOpenClawPackageFixture(root, "2026.9.3");
    params.result.root = root;
    params.result.mode = "git";
    params.rollbackBlockedReason = undefined;
    params.schemaVersions = [];
    const run = params.opts.run!;
    await expect(finishUpdate(params)).rejects.toMatchObject({
      result: { status: "error", reason: "readyz-unhealthy" },
    });
    expect(mocks.rollback).not.toHaveBeenCalled();
    expect(getUpdateRun(run.runId, { env: run.env })?.steps).toContainEqual(
      partial({ step: "package rollback", status: "skipped" }),
    );
  });

  it.each([true, false])(
    "settles Windows recovery after plugin activation without inference (healthy=%s)",
    async (activated) => {
      const params = fixture();
      const run = params.opts.run!;
      vi.stubEnv("OPENCLAW_WINDOWS_TASK_NAME", "repair-plugin-fixture");
      run.env.OPENCLAW_WINDOWS_TASK_NAME = "repair-plugin-fixture";
      const root = await fs.realpath(dirs.make("repair-plugin-windows-candidate-"));
      await writeOpenClawPackageFixture(root, "2026.9.3");
      const state: GatewayServiceState = {
        ...stoppedService(root, run.env, 2001),
        definitionMutationCapability: { kind: "sealed", reason: "system-owned" },
      };
      params.preManagedServiceStop!.serviceManagerUid = 2001;
      params.root = root;
      params.result.root = root;
      params.preManagedServiceStop!.serviceUpdateVerdict =
        await revalidateManagedGatewayServiceAfterUpdate({ state, root });
      mocks.readService.mockResolvedValue(state);
      mocks.revalidate.mockImplementation(revalidateManagedGatewayServiceAfterUpdate);
      const actual = await vi.importActual<typeof import("./update-command-rollback.js")>(
        "./update-command-rollback.js",
      );
      mocks.rollback.mockImplementation(actual.rollbackFailedUpdate);

      let enabled = true;
      mocks.execSchtasks.mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        if (args[0] === "/Run") {
          return { code: enabled ? 0 : 1, stdout: "", stderr: enabled ? "" : "task disabled" };
        }
        enabled = args.at(-1) === "/ENABLE";
        return { code: 0, stdout: "", stderr: "" };
      });
      const originalRecovery = createWindowsTaskAutoStartRecovery({ serviceEnv: run.env });
      try {
        await originalRecovery.suspended;
        originalRecovery.beginMutation();
        params.preManagedServiceStop!.windowsTaskAutoStartRecovery = originalRecovery;
        mocks.restart.mockImplementation(async (restart) => {
          expect((await mocks.execSchtasks(["/Run", "/TN", "repair-plugin-fixture"])).code).toBe(0);
          mocks.healthy = activated;
          recordUpdateRunPhase(run.runId, "verifying", undefined, { env: run.env });
          if (!mocks.healthy) {
            restart.onVerificationFailure?.("readyz-unhealthy");
          }
          const verification = await verifyUpdatedGateway({
            result: restart.result,
            opts: restart.opts,
            serviceEnv: run.env,
            gatewayPort: 19101,
            expectedVersion: restart.result.after?.version ?? undefined,
            expectedBuildId: restart.result.after?.buildId ?? undefined,
            requireRunningService: true,
            onVerified: restart.onVerified,
          });
          if (!verification.ok) {
            restart.onVerificationFailure?.(verification.summary);
          }
          return verification.ok ? "ok" : "restart-health-failed";
        });
        mocks.converge.mockImplementation(
          async (convergence: {
            result: FinishUpdateParams["result"];
            beforeDoctor?: () => Promise<void>;
          }) => {
            expect(mocks.healthy).toBe(false);
            await convergence.beforeDoctor?.();
            expect(enabled).toBe(false);
            return {
              resultWithPostUpdate: {
                ...convergence.result,
                postUpdate: { plugins: { ...successfulPluginUpdate, changed: true } },
              },
              postUpdateConfigSnapshot: params.configSnapshot,
            };
          },
        );

        if (activated) {
          await expect(finishUpdate(params)).resolves.toMatchObject({ status: "ok" });
        } else {
          await expect(finishUpdate(params)).rejects.toMatchObject({
            exitCode: 1,
            result: { status: "error" },
          });
        }
        // Refused rollback leaves the original recovery owner in charge.
        await originalRecovery.restore();
        await originalRecovery.complete();
        expect(mocks.rollback).toHaveBeenCalledTimes(activated ? 0 : 1);
        expectNoInferredRepair();
        expect(mocks.restart).toHaveBeenCalledOnce();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(enabled).toBe(activated);
      } finally {
        await originalRecovery.complete(false);
      }
    },
  );

  it("does not restart or start inference after service ownership changes", async () => {
    const params = fixture();
    mocks.revalidate.mockRejectedValueOnce(new Error("Gateway owner changed"));
    await expect(finishUpdate(params)).rejects.toMatchObject({
      result: { status: "error", reason: "state-migrated-no-rollback" },
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expectNoInferredRepair();
    const run = params.opts.run!;
    expect(getUpdateRun(run.runId, { env: run.env })).toMatchObject({
      status: "failed",
      phase: "finished",
      repair: [],
    });
  });

  it.each([
    "settled",
    "unsettled",
    "missing",
    "foreign",
    "database-restored",
    "source-rollback-failed",
    "migration-required",
    "migration-verified",
    "migration-incomplete",
    "migration-refused",
    "migration-local-current",
    "migration-local-client-newer",
    "migration-local-daemon-newer",
    "current-core-parked",
    "current-core-rollback-refused",
    "current-core-data-at-risk",
    "operator-stopped",
    "operator-stopped-before-doctor",
  ] as const)(
    "recovers the installed Gateway only for an owned stop and settled Doctor (%s)",
    async (receipt) => {
      const params = fixture("work");
      const run = params.opts.run!;
      const stateDir = run.env.OPENCLAW_STATE_DIR!;
      const swap =
        receipt === "migration-verified" ? await createRetainedPackageSwap(stateDir) : undefined;
      mocks.version = swap ? "2.0.0" : "2026.9.7";
      const root = swap?.packageRoot ?? path.join(stateDir, "candidate");
      await writeOpenClawPackageFixture(root, mocks.version, { entrySource: "export {};\n" });
      const scratch = path.join(root, "tmp");
      await fs.mkdir(scratch);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(scratch);
      params.root = root;
      const migration = receipt.startsWith("migration-");
      const localVersionOnly = receipt.startsWith("migration-local-");
      const currentCore = receipt.startsWith("current-core-") || receipt.startsWith("operator-");
      const untouched = receipt.startsWith("operator-");
      const recovered =
        receipt === "settled" ||
        receipt === "migration-required" ||
        receipt === "migration-verified" ||
        receipt === "migration-local-current" ||
        receipt === "current-core-parked" ||
        receipt === "current-core-rollback-refused";
      let agentVersion = localVersionOnly || receipt === "migration-verified" ? 23 : 21;
      const doctor = vi.spyOn(freshDoctor, "runUpdateFinalizationDoctorInFreshProcess");
      if (migration) {
        params.candidateSchemaVersions = { state: 18, agent: 23 };
        vi.spyOn(stateSchemas, "readUpdateStateSchemaVersions").mockImplementation(async () =>
          Object.entries({
            "state/openclaw.sqlite": 18,
            "agents/main/agent/openclaw-agent.sqlite": agentVersion,
            "client/credentials.sqlite": receipt === "migration-local-client-newer" ? 2 : 1,
            "control/services.sqlite": receipt === "migration-local-daemon-newer" ? 2 : 1,
          }).map(([file, userVersion]) => ({ path: path.join(stateDir, file), userVersion })),
        );
        doctor.mockImplementation(async () => {
          expect(mocks.restartCommand).not.toHaveBeenCalled();
          if (receipt === "migration-refused") {
            throw new Error("Agent database migration refused: active writer");
          }
          if (receipt === "migration-required") {
            agentVersion = 23;
          }
        });
      }
      params.result = {
        ...params.result,
        root,
        status: "error",
        before: { version: "2026.9.7" },
        after: { version: mocks.version },
        reason: "state-migrated-no-rollback",
        recovery:
          receipt === "unsettled"
            ? {
                serviceRestartSafe: true,
                version: mocks.version,
              }
            : {
                serviceRestartSafe: false,
                reason:
                  receipt === "source-rollback-failed" ? receipt : "runtime-verification-failed",
              },
        steps: [
          {
            name: currentCore ? "finalize-doctor" : "post-install verification",
            command: "openclaw doctor",
            cwd: root,
            durationMs: 5_000,
            exitCode: 1,
            termination: migration || currentCore ? "exit" : "timeout",
            stderrTail: currentCore
              ? "Doctor refused a maintenance step."
              : migration
                ? "Doctor config promotion refused: authority-check-failed: OpenClaw state is undergoing offline maintenance; retry when it finishes."
                : "Doctor timed out while repairing state.",
            failureFacts: currentCore
              ? [{ check: "maintenance", code: "step-refused" }]
              : migration
                ? [{ check: "config-write", code: "authority-check-failed" }]
                : [{ check: "package-runtime", code: "runtime-verification-failed" }],
          },
        ],
      };
      if (receipt === "migration-verified") {
        params.packageTransaction = swap?.transaction;
        params.result.steps = [
          {
            name: "verifying",
            command: "gateway verification",
            cwd: root,
            durationMs: 1,
            exitCode: null,
          },
        ];
      }
      const settledStep = {
        name: "doctor process settlement",
        command: "settle doctor process groups",
        cwd: receipt === "foreign" ? path.join(root, "other-candidate") : root,
        durationMs: 1,
        exitCode: 0,
        advisory:
          migration || currentCore
            ? undefined
            : {
                kind: "recoverable-maintenance" as const,
                message:
                  "Doctor timed out; all tracked process groups stopped. Run `openclaw update repair`.",
              },
      };
      if (receipt !== "missing" && receipt !== "migration-verified") {
        params.result.steps.push(settledStep);
      }
      const unsettledReason =
        "Doctor writers remain unsettled (PIDs: 41001, 41002). Data is at risk; run `openclaw update repair` after they stop.";
      if (receipt === "unsettled") {
        params.result.steps.push({
          ...settledStep,
          exitCode: 1,
          advisory: undefined,
          stderrTail: unsettledReason,
          failureFacts: [
            {
              check: "doctor-process-settlement",
              code: "doctor-processes-unsettled",
              message: unsettledReason,
            },
          ],
        });
      }
      if (receipt === "unsettled" || receipt === "database-restored") {
        params.result.steps.push({
          name: "database rollback",
          command: "restore database snapshot",
          cwd: root,
          durationMs: 1,
          exitCode: receipt === "database-restored" ? 0 : 1,
        });
      }
      if (currentCore) {
        const oldRun = createUpdateRun({ trigger: "cli" }, { env: run.env });
        recordUpdateRunStep(
          oldRun.runId,
          {
            step: `finalize:predecessor-stop:1:${process.getuid?.() ?? 501}:4321:fixture`,
            status: "completed",
            endedAtMs: 1,
          },
          { env: run.env },
        );
        params.coreAlreadyCurrent = true;
        params.rollbackBlockedReason =
          receipt === "current-core-rollback-refused" || receipt === "current-core-data-at-risk"
            ? "state-migrated-no-rollback"
            : undefined;
        params.mutationStarted = false;
        params.preManagedServiceStop!.stopped = false;
        params.preManagedServiceStop!.running = receipt !== "operator-stopped";
        const failureSteps = params.result.steps;
        params.result = {
          ...params.result,
          status: "skipped",
          reason: "already-current",
          recovery: undefined,
          steps: [],
        };
        mocks.stop.mockImplementation(async ({ onStopped }) => {
          const stopped = {
            ...params.preManagedServiceStop!,
            stopped: receipt !== "operator-stopped-before-doctor",
            stoppedAtMs: Date.now(),
          };
          if (stopped.stopped) {
            onStopped?.(stopped);
          }
          return stopped;
        });
        mocks.converge.mockImplementation(
          async (convergence: { beforeDoctor?: () => Promise<void> }) => {
            await convergence.beforeDoctor?.();
            if (receipt === "current-core-data-at-risk") {
              params.result.steps.push(...failureSteps);
              throw new DoctorMaintenanceRefusalError(
                "State is unreadable",
                {
                  kind: "data-at-risk",
                  reason: "unreadable-state",
                },
                {
                  failureFacts: Array.from({ length: 5 }, () => ({
                    check: "doctor",
                    code: "doctor-failed",
                  })),
                },
              );
            }
            return {
              resultWithPostUpdate: {
                ...params.result,
                status: "error",
                reason: "step-refused",
                steps: failureSteps,
              },
            };
          },
        );
      }
      const state: GatewayServiceState = {
        installed: true,
        loadState: { status: "loaded" },
        running: false,
        runtime: { status: "stopped", systemd: { managerUid: process.getuid?.() ?? 501 } },
        env: run.env,
        command: {
          programArguments: [process.execPath, path.join(root, "dist/index.js"), "gateway"],
        },
      };
      params.preManagedServiceStop!.serviceManagerUid = process.getuid?.() ?? 501;
      params.preManagedServiceStop!.serviceUpdateVerdict =
        await revalidateManagedGatewayServiceAfterUpdate({ state, root });
      mocks.revalidate.mockImplementation(revalidateManagedGatewayServiceAfterUpdate);
      mocks.readService.mockImplementation(async () => ({
        ...state,
        running: mocks.healthy,
        runtime: { ...state.runtime, status: mocks.healthy ? "running" : "stopped" },
      }));
      vi.mocked(resolveGatewayService).mockReturnValue(createMockGatewayService());
      mocks.restartCommand.mockImplementation(async (restart, action) => {
        restart.onGatewayStartAttempted?.(action);
        if (migration) {
          expect(agentVersion).toBe(23);
        }
        mocks.healthy = true;
        return "accepted";
      });
      if (!currentCore) {
        vi.mocked(verifyUpdatedGateway).mockImplementation(async ({ result }) => {
          result.verification = {
            serviceRunning: mocks.healthy,
            readyz: mocks.healthy,
            settled: mocks.healthy,
            runningVersion: mocks.version,
          };
          return { ok: mocks.healthy, score: 7, summary: "Migrated candidate is healthy" };
        });
      }

      await withUpdateCommandExecutor(run.runId, async (executor) => {
        run.executorFence = await executor.enter(root);
        const failure = await finishUpdate(params).catch((error: unknown) => error);
        assert(failure instanceof UpdateCommandFailure);
        if (localVersionOnly && !recovered) {
          const refusal = failure.result.steps.findLast(
            (step) => step.name === "gateway migration recovery",
          );
          expect(refusal?.stderrTail).toContain("expected schema 1, found 2");
          expect(refusal?.stderrTail).toContain(
            receipt === "migration-local-client-newer"
              ? path.join("client", "credentials.sqlite")
              : path.join("control", "services.sqlite"),
          );
        }
        expect(failure.result.recovery, JSON.stringify(failure.result)).toEqual(
          untouched
            ? undefined
            : partial(
                recovered
                  ? {
                      serviceRestartSafe: true,
                      service: "healthy",
                      version: mocks.version,
                    }
                  : {
                      serviceRestartSafe: false,
                      ...(receipt === "current-core-data-at-risk" && {
                        dataAtRisk: "unreadable-state",
                      }),
                    },
              ),
        );
      });
      expect(mocks.restartCommand).toHaveBeenCalledTimes(recovered ? 1 : 0);
      if (currentCore) {
        expect(mocks.stop).toHaveBeenCalledTimes(receipt === "operator-stopped" ? 0 : 1);
        expect(mocks.rollback).toHaveBeenCalledTimes(
          receipt === "current-core-rollback-refused" || receipt === "current-core-data-at-risk"
            ? 1
            : 0,
        );
      }
      if (migration) {
        expect(doctor).toHaveBeenCalledTimes(
          localVersionOnly || receipt === "migration-verified" ? 0 : 1,
        );
      }
      const report = getUpdateRun(run.runId, { env: run.env });
      expect(report?.verification.serviceRunning).toBe(untouched ? undefined : recovered);
      expect(report?.verification.readyz).toBe(untouched ? undefined : recovered);
      const rendered = renderUpdateRunReport(report!).lines.join("\n");
      if (migration) {
        expect(report?.status).toBe("failed");
        if (receipt === "migration-verified") {
          expect(report?.steps).toContainEqual(
            partial({ step: "package-backup-retention", exitCode: 1 }),
          );
        } else {
          expect(
            report?.steps.find((step) => step.step === "post-install verification")?.failureFacts,
          ).toContainEqual(partial({ code: "authority-check-failed" }));
        }
      }
      if (localVersionOnly && !recovered) {
        const refusal = report?.steps.findLast(
          (step) => step.step === "gateway migration recovery",
        );
        expect(refusal).toMatchObject({ status: "failed", exitCode: 1 });
      }
      if (migration && !recovered) {
        expect(rendered).toContain("openclaw --profile work doctor --fix");
        expect(rendered).toContain("openclaw --profile work gateway start");
      }
      if (recovered) {
        expect(rendered).toContain("openclaw --profile work update repair");
        expect(report?.origin.nextAction).toContain("installed Gateway is healthy");
        expect(report?.origin.nextAction).toContain("running on the retained state");
        expect(report?.origin.nextAction).toContain("openclaw --profile work gateway stop");
        expect(report?.origin.nextAction).not.toContain("migrated state");
      }
      if (receipt === "unsettled") {
        expect(mocks.rollback).not.toHaveBeenCalled();
        expect(report?.origin.nextAction).toContain("41001, 41002");
        expect(report?.origin.nextAction).toContain("Keep the Gateway stopped");
        expect(
          report?.steps.findLast((step) => step.step === "doctor process settlement"),
        ).toMatchObject({
          status: "failed",
          exitCode: 1,
          failureFacts: [
            {
              check: "doctor-process-settlement",
              code: "doctor-processes-unsettled",
              message: unsettledReason,
            },
          ],
        });
      }
    },
  );
});
