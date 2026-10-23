import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configOwner from "../../config/config.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-swap-contract.js";
import { swapStagedPackageInstall } from "../../infra/package-update-swap.js";
import { createPackageSwapFixture } from "../../infra/package-update-swap.test-support.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunNotice } from "../../infra/update-run-notice.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";

const mocks = vi.hoisted(() => ({
  verifyGateway: vi.fn<typeof import("./update-command-verification.js").verifyUpdatedGateway>(
    async ({ result, expectedVersion }) => {
      result.verification = {
        serviceRunning: true,
        runningVersion: expectedVersion,
        versionMatch: true,
        readyz: true,
        settled: true,
        channelsReady: true,
        pluginErrors: [],
      };
      return { ok: true, summary: "healthy" };
    },
  ),
  printResult: vi.fn(),
  gatewayCommand: vi.fn<
    typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
  >(async () => "accepted"),
  readRuntime: vi.fn(async (): Promise<{ status: string; pid?: number }> => ({
    status: "unknown",
  })),
  restartCandidate: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(
    async () => "ok",
  ),
  stopCandidate: vi.fn(),
  revalidateService: vi.fn<
    typeof import("./update-command-service-revalidation.js").revalidateManagedGatewayServiceAfterUpdate
  >(async ({ root }) => ({
    kind: "owned",
    root,
    fingerprint: "fixture",
    refreshDefinition: false,
  })),
  restart:
    vi.fn<
      typeof import("./update-command-service.js").maybeRestartServiceAfterFailedMutableUpdate
    >(),
  restoreWindowsAutoStart: vi.fn(async () => {}),
  freshProcess: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("./progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./progress.js")>()),
  printResult: mocks.printResult,
  prepareResult:
    async (...args: Parameters<typeof import("./progress.js").printResult>) =>
    () =>
      mocks.printResult(...args.slice(0, 3)),
}));
vi.mock("./update-command-verification.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-verification.js")>()),
  verifyUpdatedGateway: mocks.verifyGateway,
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.gatewayCommand,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({
    valid: true,
    config: {},
    sourceConfig: {},
    parsed: {},
    warnings: [],
    issues: [],
    legacyIssues: [],
  }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({ readRuntime: mocks.readRuntime }),
  readGatewayServiceState: async () => ({
    installed: true,
    loadState: { status: "loaded" },
    env: {},
    command: { programArguments: ["node", "/repo/dist/entry.js", "gateway"] },
  }),
}));
vi.mock("./update-command-service-revalidation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-revalidation.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
  maybeRestartService: mocks.restartCandidate,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopCandidate,
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: mocks.freshProcess,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { UpdatePreMutationError } from "./shared.js";
import { registerDoctorRestorationRollbackTests } from "./update-command-doctor-rollback.test-support.js";
import {
  finishParams,
  updateResult,
  updateStep,
} from "./update-command-maintenance-fixtures.test-support.js";
import { finishUpdate } from "./update-command-post-update.js";
import { registerRestartFailureOwnershipTest } from "./update-command-restart-failure.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
const tempDirs = useStateDatabaseTempDirs();
const updateRun = (env: NodeJS.ProcessEnv) => ({
  runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
  env,
});
const stateEnv = (prefix: string) => ({
  ...process.env,
  OPENCLAW_STATE_DIR: tempDirs.make(prefix),
});
async function installedRoot(prefix: string, version = "1.0.0") {
  const root = tempDirs.make(prefix);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  return root;
}
function expectIdle(...calls: Array<(...args: never[]) => unknown>) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
  }
}

beforeEach(() => {
  mocks.verifyGateway.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function failedResult(recovery: UpdateRunResult["recovery"]) {
  return updateResult({
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    root: "/repo",
    recovery,
  });
}

async function finishFailedUpdate(
  result: UpdateRunResult,
  options: Partial<Omit<FinishUpdateParams, "result" | "root" | "opts">> & {
    json?: boolean;
    stopped?: boolean;
    run?: FinishUpdateParams["opts"]["run"];
    originalRoot?: string;
    windowsTaskAutoStartRecovery?: NonNullable<
      FinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {},
): Promise<UpdateCommandFailure> {
  const {
    json,
    stopped = true,
    run,
    originalRoot,
    windowsTaskAutoStartRecovery,
    ...overrides
  } = options;
  return await finishUpdate(
    finishParams({
      ...overrides,
      mutationStarted: options.mutationStarted ?? true,
      result,
      root: originalRoot ?? result.root ?? "/repo",
      configSnapshot: options.configSnapshot ?? {
        path: "/fixture/openclaw.json",
        exists: false,
        raw: null,
        parsed: {},
        sourceConfig: asResolvedSourceConfig({}),
        resolved: asResolvedSourceConfig({}),
        valid: true,
        runtimeConfig: asRuntimeConfig({}),
        config: asRuntimeConfig({}),
        issues: [],
        warnings: [],
        legacyIssues: [],
      },
      updateStepTimeoutMs: 1000,
      opts: { json, run },
      preManagedServiceStop: {
        stopped,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: run?.env ?? {},
        windowsTaskAutoStartRecovery,
      },
    }),
  ).then(
    () => {
      throw new Error("Expected failed update finalization to reject");
    },
    (error: unknown) => {
      if (!(error instanceof UpdateCommandFailure)) {
        throw error;
      }
      expect(error.result).toEqual(mocks.printResult.mock.lastCall?.[0]);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      return error;
    },
  );
}

function resetRuntimeMocks() {
  vi.resetAllMocks();
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
}

describe("skipped update exit status", () => {
  beforeEach(() => {
    resetRuntimeMocks();
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  });

  it.each([
    ["dirty", 1],
    ["already-current", 0],
  ] as const)("handles %s with exit %i", async (reason, exitCode) => {
    const failure = await finishFailedUpdate(
      updateResult({ status: "skipped", mode: reason === "dirty" ? "git" : "unknown", reason }),
      { stopped: false },
    );
    expect(failure.exitCode).toBe(exitCode);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
});

describe("failed update recovery restart", () => {
  const windowsTaskAutoStartRecovery = {
    suspended: Promise.resolve(true),
    beginMutation: () => {},
    assertRecoveryCurrent: () => {},
    restore: mocks.restoreWindowsAutoStart,
    handoff: () => {},
    complete: async () => {},
    interrupted: () => false,
  };
  beforeEach(resetRuntimeMocks);

  it.each(["error", "skipped"] as const)(
    "records the %s outcome before recovery starts the Gateway",
    async (status) => {
      let now = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const env = stateEnv("update-report-before-boot-");
      const run = updateRun(env);
      mocks.restart.mockImplementationOnce(async () => {
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toMatchObject({
          status,
          durationMs: 0,
        });
        expect(mocks.printResult).not.toHaveBeenCalled();
        if (status === "error") {
          expect(getUpdateRun(run.runId, { env })?.origin.nextAction).toContain("triage");
        }
        now += 200;
      });

      await finishFailedUpdate(
        { ...failedResult({ serviceRestartSafe: true, version: "1.0.0" }), status },
        { run },
      );

      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.durationMs).toBe(0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status, durationMs: 200 });
    },
  );

  it.each([
    { mode: "git", status: "error", reason: "doctor-failed", service: "healthy" },
    { mode: "git", status: "skipped", reason: "dirty", service: "failed" },
    { mode: "pnpm", status: "error", reason: "package-swap", service: "failed" },
  ] as const)(
    "$mode $status reports terminal $service recovery",
    async ({ mode, status, reason, service }) => {
      const root = await installedRoot("update-terminal-installed-runtime-");
      mocks.restart.mockResolvedValueOnce(service);
      mocks.verifyGateway.mockResolvedValueOnce({
        ok: service === "healthy",
        summary: service === "healthy" ? "healthy" : "stopped-free",
      });
      const failure = await finishFailedUpdate(
        {
          ...failedResult({ serviceRestartSafe: true, version: "1.0.0" }),
          root,
          mode,
          status,
          reason,
          steps: [
            updateStep(reason, { command: "update", exitCode: status === "skipped" ? null : 1 }),
          ],
        },
        { json: true },
      );
      expect(mocks.restart).toHaveBeenCalledOnce();
      expect(mocks.restart).toHaveBeenCalledWith(
        expect.objectContaining({
          recovery: { serviceRestartSafe: true, version: "1.0.0" },
        }),
      );
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: service === "failed" ? "error" : status,
        recovery: { serviceRestartSafe: true, version: "1.0.0", service },
      });
      expect(failure.exitCode).toBe(1);
    },
  );

  it.each([
    { mutationStarted: false, stopped: false, waitForStartup: false },
    { mutationStarted: false, stopped: true, waitForStartup: true },
    { mutationStarted: true, stopped: false, waitForStartup: true },
  ])(
    "retains activation effects (mutation=$mutationStarted, stop=$stopped)",
    async ({ mutationStarted, stopped, waitForStartup }) => {
      const root = await installedRoot("update-recovery-startup-policy-");
      await finishFailedUpdate({ ...failedResult(undefined), root }, { mutationStarted, stopped });
      expect(mocks.verifyGateway).toHaveBeenCalledWith(expect.objectContaining({ waitForStartup }));
      expectIdle(mocks.restart, mocks.restartCandidate);
    },
  );

  it("retains structured mutation errors without authorizing service recovery", async () => {
    const restoreError = new Error("task enable denied");
    const original = new ScheduledTaskAutoStartRecoveryError(
      [new Error("service stop failed"), restoreError],
      "Native preparation and compensation failed",
      { OPENCLAW_STATE_DIR: "/fixture/state" },
    );
    const detail = formatErrorMessage(original);
    const failure = await finishFailedUpdate(
      {
        ...failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
        reason: "update-failed",
        steps: [updateStep("update", { command: "openclaw update", stderrTail: detail })],
      },
      { failure: { cause: original, detail } },
    );
    expect(failure.cause).toBe(original);
    expect(failure).toMatchObject({ detail, exitCode: 1 });
    expect(original.cause).toBe(restoreError);
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error", recovery: undefined },
    {
      status: "skipped",
      recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
    },
  ] as const)(
    "requires verified safety for Windows autostart ($status, $recovery)",
    async ({ status, recovery }) => {
      const complete = vi.fn(async () => {});
      const restore = vi.fn();
      await finishFailedUpdate(
        { ...failedResult(recovery), status },
        { windowsTaskAutoStartRecovery: { ...windowsTaskAutoStartRecovery, restore, complete } },
      );
      expect(restore).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledWith(false);
    },
  );

  it("requires a mutation-owner recovery verdict to restart", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    const failure = await finishFailedUpdate(failedResult(undefined), {
      json: true,
      stopped: false,
    });
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(failure.exitCode).toBe(79);
  });

  it.each([
    [false, false, false, true, 1, false],
    [true, false, false, true, 79, false],
    [true, true, true, true, 79, true],
    [true, false, true, true, 1, false],
    [true, true, true, false, 79, false],
  ] as const)(
    "preserves restart verdict (handoff=%s, restoreFails=%s, safe=%s, stopped=%s)",
    async (handoff, restoreFails, safe, stopped, expected, mutationFailed) => {
      vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", handoff ? "1" : undefined);
      const restoreError = new Error("restore failed");
      if (restoreFails) {
        mocks.restoreWindowsAutoStart.mockRejectedValueOnce(restoreError);
      }
      const original = mutationFailed
        ? new UpdatePreMutationError("database-schema-preflight", "target schema is incompatible")
        : undefined;
      const result = failedResult(
        safe
          ? { serviceRestartSafe: true, version: "1.0.0" }
          : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      );
      if (original) {
        result.reason = original.reason;
      }
      const failure = await finishFailedUpdate(result, {
        json: true,
        stopped,
        windowsTaskAutoStartRecovery,
        ...(original ? { failure: { cause: original, detail: formatErrorMessage(original) } } : {}),
      });
      expect(failure.exitCode).toBe(expected);
      expect(mocks.restart).toHaveBeenCalledTimes(safe && !restoreFails ? 1 : 0);
      expect(mocks.writeSentinel.mock.lastCall?.[0].result.recovery?.serviceRestartSafe).toBe(
        safe && !restoreFails,
      );
      expect(mocks.restoreWindowsAutoStart).toHaveBeenCalledTimes(safe ? 1 : 0);
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      if (safe && restoreFails) {
        expect(failure.detail).toContain(restoreError.message);
        expect(failure.detail).toContain(result.reason);
        if (original) {
          const combined = failure.cause;
          assert(
            combined instanceof AggregateError,
            "Expected both original and restoration failures",
          );
          expect(combined.errors).toEqual([original, restoreError]);
          expect(combined.cause).toBe(restoreError);
          expect(failure.detail).toContain(original.message);
        } else {
          expect(failure.cause).toBe(restoreError);
        }
      }
    },
  );

  it("does not activate when pre-restart convergence exits 80", async () => {
    mocks.restartCandidate.mockResolvedValueOnce("ok");
    vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", "1");
    const detail = "Fresh Doctor could not persist the migrated config.";
    mocks.freshProcess.mockResolvedValueOnce({ resumed: false, exitCode: 80, error: detail });
    const failure = await finishFailedUpdate(updateResult({ root: "/repo" }), {
      json: true,
      windowsTaskAutoStartRecovery,
    });
    expect(failure).toMatchObject({
      exitCode: 79,
      detail,
      result: {
        status: "error",
        reason: "post-core-update-failed",
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      },
    });
    expectIdle(mocks.restartCandidate, mocks.restoreWindowsAutoStart, mocks.restart);
  });

  it.each([true, false])(
    "persists profile and observed service stop (stopped=%s)",
    async (stopped) => {
      const env = {
        ...stateEnv("update-report-recovery-"),
        OPENCLAW_PROFILE: "work",
      };
      const run = updateRun(env);
      mocks.readRuntime.mockResolvedValue({ status: stopped ? "stopped" : "unknown" });
      await finishFailedUpdate(
        failedResult({ serviceRestartSafe: false, reason: "rollback-checkout-dirty" }),
        { stopped, run },
      );

      const nextAction = getUpdateRun(run.runId, { env })?.origin.nextAction;
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(nextAction).toContain("Run `openclaw --profile work triage`");
      expect(nextAction).toContain("openclaw --profile work update repair");
      expect(nextAction).toContain("openclaw --profile work gateway status --deep");
      expect(nextAction).not.toMatch(/keep the gateway stopped/i);
      expect(mocks.printResult.mock.lastCall?.[2]).toEqual({ nextAction });
    },
  );

  it.each([7376, 7377])(
    "reports the latest running process after the activation stop (pid=%s)",
    async (pid) => {
      const env = stateEnv("update-running-unverified-");
      const run = updateRun(env);
      recordUpdateRunVerification(
        run.runId,
        { serviceRunning: true, pid: 7376, runningVersion: "2026.9.3" },
        { env },
      );
      recordUpdateRunStep(
        run.runId,
        { step: "gateway verification", status: "failed", detail: "readyz-unhealthy" },
        { env },
      );
      mocks.readRuntime.mockResolvedValue({ status: "running", pid });

      await finishFailedUpdate(
        {
          ...failedResult({ serviceRestartSafe: false, reason: "runtime-verification-failed" }),
          reason: "state-migrated-no-rollback",
        },
        { stopped: true, run },
      );

      const recorded = getUpdateRun(run.runId, { env });
      assert(recorded, "Expected the failed update run to remain recorded");
      const version = pid === 7376 ? "2026.9.3" : undefined;
      expect(recorded.origin.nextAction).toContain(
        `The gateway is running${version ? ` ${version}` : ""} but did not pass verification`,
      );
      expect(recorded.origin.nextAction).toContain("gateway-probe-failed");
      expect(recorded.origin.nextAction).toContain("installed Gateway version could not be read");
      expect(recorded.origin.nextAction).toContain("triage");
      expect(recorded.origin.nextAction).toContain("update repair");
      expect(recorded.origin.nextAction).toContain("gateway status --deep");
      expect(recorded.origin.nextAction).not.toContain("gateway stopped");
      expect(recorded.origin.nextAction).not.toContain("remains stopped");
      expect(recorded.verification).toMatchObject({ serviceRunning: true, pid });
      expect(recorded.verification.runningVersion).toBe(version);
      expect(mocks.printResult.mock.lastCall?.[2]).toEqual({
        nextAction: recorded.origin.nextAction,
      });
      const report = renderUpdateRunReport(recorded).markdown;
      expect(report).toContain("readyz-unhealthy");
      expect(report).toContain("triage");
      expect(report).toContain("update repair");
      expect(report).not.toContain("remains stopped");
      expect(renderUpdateRunNotice(recorded, "finished")).toBe(
        "⚠️ OpenClaw couldn't finish updating.\nFor details, open Settings → Updates in the Control UI or run `openclaw update status` in your terminal.",
      );
    },
  );
});

describe("failed package update recovery safety", () => {
  beforeEach(resetRuntimeMocks);

  registerDoctorRestorationRollbackTests(mocks, (prefix) => tempDirs.make(prefix));

  it("retains recovery backup when publication and compensation fail", async () => {
    const base = tempDirs.make("update-older-target-backup-");
    const { params, packageRoot } = await createPackageSwapFixture(base);
    let retained: PackageUpdateTransaction | undefined;
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      if (
        String(args[0]) === params.stage.packageRoot ||
        String(args[0]) === retained?.backupRoot
      ) {
        throw Object.assign(new Error("package publication or compensation refused"), {
          code: "EACCES",
        });
      }
      return rename(...args);
    });
    let result;
    try {
      result = await swapStagedPackageInstall({
        ...params,
        onTransaction: (value) => {
          retained = value;
        },
      });
      assert(retained, "The package owner did not retain its recovery transaction.");
      expect((await retained.rollback(() => {})).exitCode).toBe(1);
      expect(renameSpy).toHaveBeenCalledWith(retained.backupRoot, packageRoot);
    } finally {
      renameSpy.mockRestore();
    }
    assert(retained, "The package owner did not retain its recovery transaction.");
    const transaction = retained;
    expect(result).toMatchObject({ status: "failed", activePackageRoot: null });
    const backupRuntime = path.join(transaction.backupRoot, "dist", "index.js");
    const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(base, "state") };
    const run = updateRun(env);
    await expect(fs.readFile(backupRuntime, "utf8")).resolves.toBe("export {};\n");

    const failure = await finishFailedUpdate(
      updateResult({
        status: "error",
        reason: result.step.name,
        root: result.activePackageRoot ?? undefined,
        before: { version: "1.0.0" },
        steps: [result.step],
        recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      }),
      {
        run,
        originalRoot: packageRoot,
        packageTransaction: transaction,
        schemaVersions: undefined,
        stopped: false,
      },
    );

    await expect(fs.readFile(backupRuntime, "utf8")).resolves.toBe("export {};\n");
    expect(failure.result.root).toBeUndefined();
    expect(failure.result.recovery?.serviceRestartSafe).toBe(false);
    expect(getUpdateRun(run.runId, { env })?.status).toBe("failed");
    expect(failure.result.steps).toContainEqual(
      expect.objectContaining({ stderrTail: expect.stringContaining(transaction.backupRoot) }),
    );
    expectIdle(mocks.restart, mocks.restartCandidate);
  });

  it.each([false, true])(
    "settles Doctor-rewritten config (operator edit=%s)",
    async (operatorEdit) => {
      const stateDir = tempDirs.make("update-managed-rollback-");
      const configPath = path.join(stateDir, "openclaw.json");
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
      };
      const config = {
        gateway: { mode: "local" },
        agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
        plugins: { enabled: false },
      };
      const original = `${JSON.stringify(config, null, 4)}\n`;
      await fs.writeFile(configPath, original, { mode: 0o600 });
      await fs.writeFile(`${configPath}.pre-update`, original, { mode: 0o600 });
      const io = configOwner.createConfigIO({
        env,
        pluginValidation: "core-only",
        observe: false,
        suppressFutureVersionWarning: true,
      });
      const configSnapshot = await io.readConfigFileSnapshot();
      expect(configSnapshot.valid).toBe(true);
      vi.spyOn(configOwner, "readConfigFileSnapshot").mockImplementation(() =>
        io.readConfigFileSnapshot(),
      );
      const doctorConfig = {
        ...config,
        meta: { migrations: { modelPolicyAllowlist: true }, lastTouchedVersion: "2026.9.3" },
        agents: {
          defaults: { ...config.agents.defaults, modelPolicy: { allow: ["openai/gpt-5.6-luna"] } },
        },
        wizard: { lastRunCommand: "doctor", lastRunVersion: "2026.9.3" },
      };
      const doctorRaw = `${JSON.stringify(doctorConfig, null, 2)}\n`;
      await fs.writeFile(configPath, doctorRaw);
      const activationConfig = {
        path: configPath,
        raw: original,
        hash: createHash("sha256").update(doctorRaw).digest("hex"),
      };
      const current = operatorEdit
        ? `${JSON.stringify({ ...doctorConfig, logging: { level: "debug" } }, null, 2)}\n`
        : doctorRaw;
      if (operatorEdit) {
        await fs.writeFile(configPath, current);
      }
      const run = updateRun(env);
      const schemaVersions = await readUpdateStateSchemaVersions({
        stateDir: env.OPENCLAW_STATE_DIR,
        config: {},
        env,
      });
      const originalRoot = await installedRoot("update-restored-installed-runtime-", "2026.9.1");
      mocks.stopCandidate.mockResolvedValue({
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned",
          root: process.cwd(),
          fingerprint: "fixture",
          refreshDefinition: true,
        },
      });
      mocks.restartCandidate.mockResolvedValueOnce("ok");
      const rollback = vi.fn(async () => ({
        ...updateStep("package rollback", { command: "restore", cwd: originalRoot, exitCode: 0 }),
        activePackageRoot: originalRoot,
      }));
      let cleanupStatus: string | undefined;
      const complete = vi.fn(async () => {
        cleanupStatus = getUpdateRun(run.runId, { env })?.status;
      });
      const failure = await finishFailedUpdate(
        updateResult({
          status: "error",
          mode: "pnpm",
          root: process.cwd(),
          before: { version: "2026.9.1" },
          after: { version: "2026.9.3" },
          reason: "version-mismatch",
        }),
        {
          run,
          originalRoot,
          previousInstallRoot: "/shell/unrelated",
          schemaVersions,
          configSnapshot,
          activationConfig,
          previousVerified: true,
          packageTransaction: { backupRoot: "/managed/backup", rollback, complete },
        },
      );
      const recorded = getUpdateRun(run.runId, { env });
      assert(recorded, "Expected the completed update to remain recorded");
      if (operatorEdit) {
        expect(failure.result.reason).toBe("state-migrated-no-rollback");
        expect(recorded.status).toBe("failed");
        expect(recorded.origin.nextAction).toContain("openclaw.json");
        expect(await fs.readFile(configPath, "utf8")).toBe(current);
        expectIdle(rollback, mocks.restartCandidate);
        return;
      }
      expect(failure.result).toMatchObject({ root: originalRoot, after: { version: "2026.9.1" } });
      expect(
        mocks.restartCandidate.mock.lastCall?.[0],
        JSON.stringify(failure.result),
      ).toMatchObject({
        result: { root: originalRoot, after: { version: "2026.9.1" } },
      });
      expect(rollback).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
      // Cleanup is pre-terminal; rollback is recorded only after completion settles.
      expect(cleanupStatus).toBe("running");
      expect(recorded.status).toBe("rolled-back");
      expect(renderUpdateRunReport(recorded).headline).toContain("↩️ OpenClaw update rolled back");
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
      if (process.platform !== "win32") {
        expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
      }
    },
  );

  it("does not start a Doctor-rejected candidate even after a verified swap", async () => {
    const failure = await finishFailedUpdate(
      updateResult({
        status: "error",
        reason: "doctor-failed",
        steps: [
          updateStep("package-install", { command: "npm", cwd: "/", exitCode: 0 }),
          updateStep("openclaw doctor", { command: "doctor", cwd: "/" }),
        ],
        recovery: {
          serviceRestartSafe: false,
          reason: "runtime-verification-failed",
          packageRollbackVerified: true,
        },
      }),
    );
    expect(failure.exitCode).toBe(1);

    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.writeSentinel.mock.lastCall?.[0].result.recovery).toEqual({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
      packageRollbackVerified: true,
    });
  });
});

registerRestartFailureOwnershipTest({
  makeTempDir: (prefix) => tempDirs.make(prefix),
  gatewayCommand: mocks.gatewayCommand,
});
