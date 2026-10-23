import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gatewayService from "../../daemon/service.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import * as ports from "../../infra/ports-inspect.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import * as updateLedger from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { defaultRuntime } from "../../runtime.js";
import * as utils from "../../utils.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import {
  finishSuccessfulPackageSwitch,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import { UpdateCommandFailure as ReportedUpdateCommandFailure } from "./update-command-result.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { withUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

const mocks = vi.hoisted(() => ({
  activePort: vi.fn<typeof import("../../infra/gateway-lock.js").readActiveGatewayLockPort>(
    async () => undefined,
  ),
  managedService: vi.fn<
    typeof import("./update-command-service-plan.js").readManagedGatewayServiceForUpdate
  >(async () => null),
  converge: vi.fn<typeof import("./update-command-convergence.js").convergeUpdatePlugins>(),
  printResult: vi.fn(),
  task: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
// Native Windows transport only; the finalizer and autostart recovery owner stay real.
vi.mock("../../daemon/schtasks-exec.js", async () => ({
  ...(await vi.importActual<typeof import("../../daemon/schtasks-exec.js")>(
    "../../daemon/schtasks-exec.js",
  )),
  execSchtasks: mocks.task,
  execScheduledTaskEnabledChange: (name: string, enabled: boolean) =>
    mocks.task(["/Change", "/TN", name, enabled ? "/ENABLE" : "/DISABLE"]),
}));
vi.mock("./update-command-convergence.js", () => ({ convergeUpdatePlugins: mocks.converge }));
vi.mock("./progress.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./progress.js")>()),
  printResult: mocks.printResult,
  prepareResult:
    async (...args: Parameters<typeof import("./progress.js").printResult>) =>
    () =>
      mocks.printResult(...args.slice(0, 3)),
}));
vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockPort: mocks.activePort,
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  readManagedGatewayServiceForUpdate: mocks.managedService,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
const containing = (value: unknown) => expect.objectContaining(value);
function resultWith(overrides: Partial<UpdateRunResult>): UpdateRunResult {
  return { status: "error", mode: "npm", steps: [], durationMs: 0, ...overrides };
}
function stepWith(name: string, overrides: Partial<UpdateStepResult>): UpdateStepResult {
  return { name, command: name, cwd: root, durationMs: 1, exitCode: 0, ...overrides };
}
const noCalls = (...fns: unknown[]) => {
  for (const fn of fns) {
    expect(fn).not.toHaveBeenCalled();
  }
};
const failedPlugins = (recovery?: {
  serviceRestartSafe: false;
  reason: "state-migration-started";
}) =>
  mocks.converge.mockImplementationOnce(async ({ result }) => ({
    resultWithPostUpdate: {
      ...result,
      status: "error",
      reason: "post-update-plugins",
      ...(recovery && { recovery }),
    },
  }));
function mockService(
  readRuntime: ReturnType<typeof gatewayService.resolveGatewayService>["readRuntime"],
) {
  vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
    ...gatewayService.resolveGatewayService(),
    readRuntime,
    readCommand: vi.fn(async () => null),
    isLoaded: vi.fn(async () => false),
  });
}
function mockFreePort() {
  return vi.spyOn(ports, "inspectPortUsage").mockImplementation(async (port) => ({
    port,
    status: "free",
    listeners: [],
    hints: [],
  }));
}
async function useRealVerification() {
  const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
    "./update-command-verification.js",
  );
  vi.mocked(verifyUpdatedGateway).mockImplementationOnce(actual.verifyUpdatedGateway);
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.converge.mockReset();
  mocks.task.mockReset();
  mocks.activePort.mockReset();
  mocks.managedService.mockReset();
  vi.mocked(verifyUpdatedGateway)
    .mockReset()
    .mockResolvedValue({ ok: false, summary: "stopped-free" });
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("failure-recovery-state-"));
  root = dirs.make("failure-recovery-package-");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "2026.9.5" }),
  );
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(
  (["linux", "win32"] as const).flatMap((platform) =>
    [false, true].map((dataAtRisk) => ({ platform, dataAtRisk })),
  ),
)(
  "recovers a Gateway after an exited Doctor on $platform unless data is at risk ($dataAtRisk)",
  async ({ platform, dataAtRisk }) => {
    const [
      { createMockGatewayService },
      { withUpdateCommandExecutor },
      { createPostUpdateRepairFixture },
      { finishUpdate },
      serviceCommand,
      serviceMaintenance,
      servicePlan,
      serviceOperations,
      { createWindowsTaskAutoStartRecovery },
      nodeSqlite,
      processIdentity,
      snapshotStaging,
    ] = await Promise.all([
      import("../../daemon/service.test-helpers.js"),
      import("./update-command-executor.js"),
      import("./update-command-post-update-repair.test-support.js"),
      import("./update-command-post-update.js"),
      import("./update-command-service-command.js"),
      import("./update-command-service-maintenance.js"),
      import("./update-command-service-plan.js"),
      import("./update-command-service.js"),
      import("./update-command-windows-task.js"),
      import("../../infra/node-sqlite.js"),
      import("../../shared/pid-alive.js"),
      import("../../infra/sqlite-snapshot-staging.js"),
    ]);
    const hostPlatform = process.platform;
    const existingUri = nodeSqlite.resolveExistingSqliteFileUri;
    vi.spyOn(nodeSqlite, "resolveExistingSqliteFileUri").mockImplementation((pathname) =>
      existingUri(pathname, hostPlatform),
    );
    const servicePlatform = vi.spyOn(process, "platform", "get").mockReturnValue(hostPlatform);
    // Native process identity and SQLite staging still belong to the real host.
    const onHost = <T>(read: () => T): T => {
      const activePlatform = process.platform;
      servicePlatform.mockReturnValue(hostPlatform);
      try {
        return read();
      } finally {
        servicePlatform.mockReturnValue(activePlatform);
      }
    };
    const readStart = processIdentity.getFileLockProcessStartTime;
    vi.spyOn(processIdentity, "getFileLockProcessStartTime").mockImplementation((...args) =>
      onHost(() => readStart(...args)),
    );
    const createStaging = snapshotStaging.createSqliteSnapshotStagingDirectorySync;
    vi.spyOn(snapshotStaging, "createSqliteSnapshotStagingDirectorySync").mockImplementation(
      (...args) => onHost(() => createStaging(...args)),
    );
    const params = createPostUpdateRepairFixture(root);
    const run = params.opts.run!;
    params.root = root;
    params.result = {
      ...params.result,
      root,
      status: "skipped",
      reason: "already-current",
      before: { version: "2026.9.5" },
      after: { version: "2026.9.5" },
    };
    params.coreAlreadyCurrent = true;
    params.mutationStarted = false;
    params.rollbackBlockedReason = undefined;
    params.preManagedServiceStop!.stopped = false;
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist/index.js"), "export {};\n");
    let running = true;
    let enabled = true;
    mocks.task.mockImplementation(async (args) => {
      if (args[0] === "/Query") {
        return {
          code: 0,
          stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
          stderr: "",
        };
      }
      if (args[0] === "/Run") {
        if (enabled) {
          running = true;
        }
        return { code: enabled ? 0 : 1, stdout: "", stderr: "" };
      }
      enabled = args.at(-1) === "/ENABLE";
      return { code: 0, stdout: "", stderr: "" };
    });
    const state = () => ({
      installed: true,
      loadState: { status: "loaded" as const },
      running,
      runtime: {
        status: running ? ("running" as const) : ("stopped" as const),
        pid: running ? 4321 : undefined,
        ...(platform === "linux" ? { systemd: { managerUid: 2001 } } : {}),
      },
      env: run.env,
      command: {
        programArguments: [process.execPath, path.join(root, "dist/index.js"), "gateway"],
        ...(platform === "win32" ? { sourcePath: path.join(root, "gateway.cmd") } : {}),
      },
    });
    vi.spyOn(servicePlan, "readGatewayServiceStateForUpdate").mockImplementation(async () =>
      state(),
    );
    vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue(
      createMockGatewayService({
        readRuntime: async () => state().runtime,
      }),
    );
    const stop = vi
      .spyOn(serviceOperations, "maybeStopManagedServiceBeforeMutableUpdate")
      .mockImplementation(async ({ onStopped }) => {
        const recovery =
          platform === "win32"
            ? createWindowsTaskAutoStartRecovery({ serviceEnv: run.env })
            : undefined;
        await recovery?.suspended;
        running = false;
        const stopped = {
          ...params.preManagedServiceStop!,
          stopped: true,
          windowsTaskAutoStartRecovery: recovery,
        };
        onStopped?.(stopped);
        return stopped;
      });
    const facts = Array.from({ length: 4 }, (_, index) => ({
      check: `fixture-check-${index + 1}`,
      code: "step-refused",
    }));
    mocks.converge.mockImplementationOnce(async ({ beforeDoctor, result }) => {
      await beforeDoctor?.();
      return {
        resultWithPostUpdate: {
          ...result,
          status: "error",
          reason: "post-update-plugins",
          ...(dataAtRisk
            ? {
                recovery: {
                  serviceRestartSafe: false,
                  reason: "runtime-verification-failed",
                  dataAtRisk: "unreadable-state",
                },
              }
            : {}),
          steps: [
            ...result.steps,
            stepWith("post-plugin doctor", { exitCode: 1, failureFacts: facts }),
          ],
        },
      };
    });
    const start = vi
      .spyOn(serviceCommand, "runUpdatedInstallGatewayCommand")
      .mockImplementation(async (command, action) => {
        command.onGatewayStartAttempted?.(action);
        if (platform === "win32") {
          const launched = await mocks.task(["/Run", "/TN", "fixture-gateway"]);
          if (launched.code !== 0) {
            throw new Error("Scheduled Task remained disabled after Doctor failure");
          }
        } else {
          running = true;
        }
        return "accepted";
      });
    const health = async () => ({
      healthy: running,
      outcome: running ? ("ready" as const) : ("failed" as const),
      runtime: state().runtime,
      gatewayVersion: "2026.9.5",
      portUsage: {
        port: 19431,
        status: running ? ("busy" as const) : ("free" as const),
        listeners: [],
        hints: [],
      },
      staleGatewayPids: [],
      waitOutcome: running ? ("healthy" as const) : ("stopped-free" as const),
    });
    vi.spyOn(restartHealth, "waitForGatewayHealthyRestart").mockImplementation(health);
    vi.spyOn(restartHealth, "inspectGatewayRestart").mockImplementation(health);
    vi.spyOn(restartHealth, "waitForGatewayHttpReadiness").mockImplementation(async () => ({
      healthz: running ? 200 : 503,
      readyz: running ? 200 : 503,
    }));
    const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
      "./update-command-verification.js",
    );
    vi.mocked(verifyUpdatedGateway).mockImplementation(actual.verifyUpdatedGateway);
    mocks.activePort.mockResolvedValue(19431);
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      run.executorFence = await executor.enter(root);
      servicePlatform.mockReturnValue(platform);
      try {
        params.preManagedServiceStop!.serviceUpdateVerdict =
          await serviceMaintenance.revalidateManagedGatewayServiceAfterUpdate({
            state: state(),
            root,
          });
        await expect(finishUpdate(params)).rejects.toMatchObject({
          result: {
            status: "error",
            recovery: dataAtRisk
              ? { serviceRestartSafe: false, dataAtRisk: "unreadable-state" }
              : { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
          },
        });
      } finally {
        servicePlatform.mockReturnValue(hostPlatform);
      }
    });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledTimes(dataAtRisk ? 0 : 1);
    expect(running).toBe(!dataAtRisk);
    if (platform === "win32") {
      expect(enabled).toBe(!dataAtRisk);
    } else {
      expect(mocks.task).not.toHaveBeenCalled();
    }
    const recorded = updateLedger.getUpdateRun(run.runId, { env: run.env });
    expect(
      recorded?.steps.find((step) => step.step === "post-plugin doctor")?.failureFacts,
    ).toEqual(expect.arrayContaining(facts));
    assert(recorded);
    const report = renderUpdateRunReport(recorded).markdown;
    for (const fact of facts) {
      expect(report).toContain(fact.check);
    }
  },
);

it.each(["managed-service-preflight", "gateway-stop-unverified"])(
  "records untouched %s as no recovery needed and still serving before",
  async (reason) => {
    const { verifyUpdateFailureRecovery } = await import("./update-command-failure-recovery.js");
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const result = await verifyUpdateFailureRecovery({
      result: resultWith({
        reason,
        before: { version: "2026.10.3" },
      }),
      root,
      env,
      opts: { json: true, run },
      preManagedServiceStop: {
        stopped: false,
        inspected: false,
        runtimeInspected: true,
        running: true,
        serviceUpdateVerdict: { kind: "unavailable", message: "inspection unavailable" },
      },
    });
    completeUpdateCommandRun(result, run);
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    assert(recorded);
    expect(recorded).toMatchObject({ status: "failed", reason });
    expect(renderUpdateRunReport(recorded).markdown).not.toContain("restart-unhealthy");
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "gateway recovery observation",
        exitCode: 0,
        diagnostics: [
          "No recovery needed; still serving 2026.10.3. No service was stopped or started.",
        ],
      }),
    );
    noCalls(mocks.activePort, mocks.managedService, verifyUpdatedGateway);
  },
);

it.each([
  { mutationStarted: false, dataAtRisk: false },
  { mutationStarted: true, dataAtRisk: false },
  { mutationStarted: false, dataAtRisk: true },
])(
  "records package-swap recovery (mutation=$mutationStarted, risk=$dataAtRisk)",
  async ({ mutationStarted, dataAtRisk }) => {
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    mockService(vi.fn(async () => ({ status: "unknown" })));
    mockFreePort();
    await useRealVerification();
    const failure = await finishSuccessfulPackageSwitch(
      { packageRoot: root, json: true, run },
      {
        mutationStarted,
        shouldRestart: false,
        opts: { json: true, restart: false, run },
        preManagedServiceStop: {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceEnv: env,
        },
        result: resultWith({
          mode: "pnpm",
          root,
          reason: "package-swap",
          before: { version: "2026.9.5" },
          ...(dataAtRisk && {
            recovery: {
              serviceRestartSafe: false,
              reason: "runtime-verification-failed",
              dataAtRisk: "unreadable-state",
            },
          }),
          steps: [stepWith("package-swap", { exitCode: 1 })],
        }),
      },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "UpdateCommandFailure",
      result: { status: "error", reason: "package-swap" },
    });
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    assert(recorded);
    const report = renderUpdateRunReport(recorded).markdown;
    if (mutationStarted || dataAtRisk) {
      expect(verifyUpdatedGateway).toHaveBeenCalledOnce();
      expect(recorded.steps).toContainEqual(
        containing({ step: "gateway recovery verification", exitCode: 1 }),
      );
    } else {
      expect(report).not.toContain("restart-unhealthy");
      expect(recorded.steps).toContainEqual(
        containing({ step: "gateway recovery observation", exitCode: 0 }),
      );
      expect(recorded.steps).toContainEqual(
        containing({
          step: "diagnostic:gateway recovery observation",
          detail: "No recovery needed; still serving 2026.9.5. No service was stopped or started.",
        }),
      );
      noCalls(mocks.activePort, mocks.managedService, verifyUpdatedGateway);
    }
    expect(mocks.converge).not.toHaveBeenCalled();
  },
);

it("settles a headless package rollback without waiting for a Gateway", async () => {
  const { packageRoot, transaction } = await createRetainedPackageSwap(root);
  const configPath = path.join(process.env.OPENCLAW_STATE_DIR!, "openclaw.json");
  const declaration = runtimeProcessEntrypoints.updateCandidateState;
  const worker = path.join(packageRoot, "dist", declaration.distWorkerPath);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(
    worker,
    `import ${JSON.stringify(resolveRuntimeWorkerUrl(declaration).href)};\n`,
  );
  const schemaVersions = await readUpdateStateSchemaVersions({
    stateDir: process.env.OPENCLAW_STATE_DIR!,
    config: {},
    env: process.env,
  });
  const readRuntime = vi.fn(async () => ({ status: "stopped", missingUnit: true }));
  mockService(readRuntime);
  const inspect = mockFreePort();
  const sleep = vi.spyOn(utils, "sleep").mockImplementation(async () => {
    throw new Error("Headless recovery must not wait for Gateway startup");
  });
  await useRealVerification();
  failedPlugins();
  const failure = await finishSuccessfulPackageSwitch(
    { packageRoot, json: true },
    {
      opts: { json: true, restart: false },
      shouldRestart: false,
      packageTransaction: transaction,
      rollbackBlockedReason: undefined,
      schemaVersions,
      configSnapshot: {
        ...validConfigSnapshot,
        path: configPath,
        exists: false,
        raw: null,
        resolved: {},
      },
      preManagedServiceStop: {
        stopped: false,
        inspected: true,
        runtimeInspected: true,
        running: false,
        serviceMutationAllowed: false,
        serviceUpdateVerdict: { kind: "absent" },
      },
      result: resultWith({
        status: "ok",
        root: packageRoot,
        before: { version: "1.0.0" },
        after: { version: "2.0.0" },
        durationMs: 1,
      }),
    },
  ).catch((error: unknown) => error);
  if (!(failure instanceof ReportedUpdateCommandFailure)) {
    throw failure;
  }
  expect(failure).toMatchObject({
    name: "UpdateCommandFailure",
    result: {
      status: "error",
      reason: "post-update-plugins",
      rollbackOutcome: { status: "succeeded" },
      recovery: { packageRollbackVerified: true },
    },
  });
  await expect(fs.readFile(path.join(packageRoot, "package.json"), "utf8")).resolves.toContain(
    '"version":"1.0.0"',
  );
  noCalls(sleep, readRuntime, inspect, verifyUpdatedGateway);
  expect(failure.result.verification).toEqual({});
  expect(failure.result.steps).toContainEqual(
    containing({
      name: "gateway recovery observation",
      diagnostics: [expect.stringContaining("no Gateway service or listener")],
    }),
  );
});

it.each([
  { activated: false, json: true, deferred: false },
  { activated: true, json: false, deferred: false },
  { activated: true, json: true, deferred: false },
  { activated: true, json: false, deferred: true },
  { activated: true, json: true, deferred: true },
])(
  "observes untouched failures and defers recorded state contention (activated=$activated, json=$json, deferred=$deferred)",
  async ({ activated, json, deferred }) => {
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    const readRuntime = vi.fn(async () => ({ status: "unknown" }));
    mockService(readRuntime);
    const inspect = mockFreePort();
    let elapsedMs = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
    const sleep = vi.spyOn(utils, "sleep").mockImplementation(async (ms) => {
      elapsedMs += ms;
    });
    const waitForStartup = vi.spyOn(restartHealth, "waitForGatewayHealthyRestart");
    mocks.activePort.mockResolvedValueOnce(19431);
    await useRealVerification();
    const failure = await withUpdateCommandTerminalResult(async (registerRun) => {
      registerRun(run);
      await finishSuccessfulPackageSwitch(
        { packageRoot: root, run, json },
        {
          mutationStarted: activated,
          shouldRestart: !activated,
          opts: { json, restart: !activated, run },
          preManagedServiceStop: {
            stopped: false,
            inspected: true,
            runtimeInspected: true,
            running: false,
            serviceEnv: env,
          },
          result: resultWith({
            root,
            reason: "doctor-failed",
            recovery: { serviceRestartSafe: true, version: "2026.9.5" },
            steps: [
              ...(deferred
                ? [
                    stepWith("post-install-verify", {
                      command: "verify installed package",
                      durationMs: 0,
                      exitCode: null,
                      advisory: {
                        kind: "recoverable-maintenance" as const,
                        message: "State verification deferred to the operator restart.",
                      },
                    }),
                  ]
                : []),
              stepWith("candidate-doctor-lint", {
                command: "doctor",
                exitCode: 2,
              }),
            ],
            durationMs: 1,
          }),
        },
      );
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "UpdateCommandFailure",
      exitCode: 1,
      result: { status: "error", reason: "doctor-failed" },
    });
    if (!(failure instanceof ReportedUpdateCommandFailure)) {
      throw failure;
    }
    expect(readRuntime).toHaveBeenCalledTimes(activated && !deferred ? 1 : 0);
    expect(inspect).toHaveBeenCalledTimes(activated && !deferred ? 1 : 0);
    noCalls(sleep, waitForStartup);
    expect(elapsedMs).toBe(0);
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    expect(recorded).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "doctor-failed",
    });
    if (activated) {
      expect(recorded?.steps).toContainEqual(
        containing({
          step: "restart",
          status: "skipped",
          detail: "skipped by operator",
        }),
      );
    }
    expect(recorded?.verification.serviceRunning).toBeUndefined();
    expect(recorded?.verification.readyz).toBe(activated && !deferred ? false : undefined);
    expect(recorded?.steps).toContainEqual(
      containing({ step: "candidate-doctor-lint", exitCode: 2 }),
    );
    const recoveryStep = recorded?.steps.find(
      (step) => step.step === "gateway recovery verification",
    );
    if (activated) {
      expect(recoveryStep).toMatchObject({
        status: deferred ? "completed" : "failed",
        exitCode: deferred ? null : 1,
      });
    } else {
      expect(recoveryStep).toBeUndefined();
      expect(recorded?.steps).toContainEqual(
        containing({ step: "gateway recovery observation", exitCode: 0 }),
      );
    }
    if (deferred) {
      expect(recoveryStep?.detail).toContain("deferred");
      expect(recoveryStep?.detail).toContain("service owner");
      expect(recoveryStep?.detail).toContain(
        "Resolve the recorded update failure before restarting",
      );
      expect(recoveryStep?.failureFacts).toBeUndefined();
      assert(recorded);
      expect(renderUpdateRunReport(recorded).markdown).toContain("openclaw update status");
    }
    expect(
      failure.result.steps.find((step) => step.name === "gateway recovery verification")
        ?.termination,
    ).toBeUndefined();
    expect(recoveryStep?.failureFacts?.some((fact) => fact.code === "timeout") ?? false).toBe(
      false,
    );
    expect(mocks.converge).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
  },
);

it.each(["observation", "terminal", "standalone"] as const)(
  "keeps pending recovery facts coherent at %s publication after a transient write failure",
  async (publication) => {
    const { verifyUpdateFailureRecovery } = await import("./update-command-failure-recovery.js");
    const env = { ...process.env };
    const lifecycle = new UpdateFinalizationLifecycle(true, undefined, () => {});
    lifecycle.root = root;
    const run = {
      runId:
        publication === "standalone"
          ? lifecycle.attachLedger()
          : updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId,
    };
    updateLedger.recordUpdateRunVerification(
      run.runId,
      {
        serviceRunning: true,
        versionMatch: true,
        readyz: true,
        settled: true,
        runningVersion: "2026.9.5",
        channelsReady: true,
        pluginErrors: [],
        recovery: { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" },
      },
      { env },
    );
    updateLedger.recordUpdateRunStep(
      run.runId,
      {
        step: "gateway recovery verification",
        status: "completed",
        exitCode: 0,
      },
      { env },
    );
    const capture = vi.spyOn(updateLedger, "recordUpdateRunDiagnostics");
    if (publication !== "observation") {
      capture.mockImplementationOnce((_id, _facts, warn) => {
        warn("fixture observation write refused");
      });
    }
    mocks.activePort.mockResolvedValueOnce(19431);
    vi.mocked(verifyUpdatedGateway).mockImplementationOnce(async (params) => {
      const actual = await vi.importActual<typeof import("./update-command-verification.js")>(
        "./update-command-verification.js",
      );
      return actual.verifyUpdatedGateway({
        ...params,
        health: {
          healthy: false,
          waitOutcome: "still-starting",
          runtime: { status: "running", pid: 8000 },
          portUsage: { port: 19431, status: "free", listeners: [], hints: [] },
          staleGatewayPids: [],
        },
      });
    });
    const failureResult = resultWith({ reason: "post-update-plugins" });
    if (publication === "standalone") {
      await lifecycle.observeFailure(new ReportedUpdateCommandFailure(failureResult));
      lifecycle.complete(1);
    } else {
      const observed = await verifyUpdateFailureRecovery({
        result: failureResult,
        root,
        env,
        opts: { json: true, run: { runId: run.runId, env } },
      });
      if (publication === "terminal") {
        completeUpdateCommandRun(observed, { runId: run.runId, env });
      }
    }
    expect(capture).toHaveBeenCalled();
    const recorded = updateLedger.getUpdateRun(run.runId, { env });
    expect(recorded).toMatchObject({
      confirmedAtMs: null,
      verification: { readyz: false },
      status: publication === "observation" ? "running" : "failed",
    });
    expect(recorded?.verification.runningVersion).toBeUndefined();
    expect(
      recorded?.steps.findLast((step) => step.step === "gateway recovery verification")?.exitCode,
    ).toBeNull();
    if (!recorded) {
      throw new Error("Missing recovery observation record");
    }
    expect(renderUpdateRunReport(recorded).markdown).not.toContain("verified serving");
  },
);

it("does not reconfirm the same Gateway version against a different installed build", async () => {
  const runningVersion = "2026.9.5";
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist", "build-info.json"),
    JSON.stringify({ buildId: "installed-build" }),
  );
  const lifecycle = new UpdateFinalizationLifecycle(true, undefined, () => {});
  lifecycle.root = root;
  const runId = lifecycle.attachLedger();
  updateLedger.recordUpdateRunVerification(runId, {
    recovery: {
      serviceRestartSafe: true,
      service: "healthy",
      version: runningVersion,
      buildId: "previous-build",
    },
  });
  mocks.activePort.mockResolvedValueOnce(19431);
  vi.mocked(verifyUpdatedGateway).mockImplementationOnce(
    async ({ expectedVersion, expectedBuildId }) => {
      const ok = expectedVersion === runningVersion && expectedBuildId === "previous-build";
      return {
        ok,
        summary: ok ? "healthy" : "installed runtime identity mismatch",
      };
    },
  );
  const observed = await lifecycle.observeFailure(new Error("plugin finalization failed"));
  lifecycle.complete(1);
  expect(observed?.recovery).toMatchObject({
    service: "failed",
    reason: "installed runtime identity mismatch",
  });
  expect(updateLedger.getUpdateRun(runId)?.verification.recovery).toMatchObject({
    service: "failed",
  });
  expect(verifyUpdatedGateway).toHaveBeenLastCalledWith(
    expect.objectContaining({
      expectedVersion: "2026.9.5",
      expectedBuildId: "installed-build",
    }),
  );
});

it.each(["ownership", "native status"] as const)(
  "does not publish recovery while %s inspection cleanup is uncertain",
  async (kind) => {
    const cleanup = new CommandProcessCleanupError();
    const env = { ...process.env };
    const run = { runId: updateLedger.createUpdateRun({ trigger: "cli" }, { env }).runId, env };
    if (kind === "native status") {
      mocks.activePort.mockResolvedValueOnce(19431);
      vi.spyOn(gatewayService, "resolveGatewayService").mockReturnValue({
        ...gatewayService.resolveGatewayService(),
        readRuntime: async () => {
          throw cleanup;
        },
      });
    } else {
      mocks.managedService.mockRejectedValueOnce(cleanup);
    }
    failedPlugins();
    await expect(
      withUpdateCommandTerminalResult(async (registerRun) => {
        registerRun(run);
        await finishSuccessfulPackageSwitch({
          packageRoot: root,
          json: true,
          run,
          ...(kind === "native status" ? { restartEnvironment: env, stoppedForUpdate: true } : {}),
        });
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(CommandProcessCleanupError);
      expect(collectNestedErrorCandidates(error)).toContain(cleanup);
      return true;
    });
    expect(updateLedger.getUpdateRun(run.runId, { env })?.status).toBe("running");
    noCalls(mocks.printResult, verifyUpdatedGateway);
  },
);

it.each([
  { endpoint: "foreground", failure: "returned", unsafe: false },
  { endpoint: "managed", failure: "returned", unsafe: false },
  { endpoint: "configured", failure: "returned", unsafe: false },
  { endpoint: "configured", failure: "thrown", unsafe: false },
  { endpoint: "configured", failure: "returned", unsafe: true },
] as const)(
  "observes $endpoint recovery after $failure failure (unsafe=$unsafe)",
  async ({ endpoint, failure, unsafe }) => {
    const effectivePort = endpoint !== "configured";
    if (effectivePort) {
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", "19430");
    }
    if (endpoint === "foreground") {
      mocks.activePort.mockResolvedValueOnce(19431);
    } else if (endpoint === "managed") {
      mocks.managedService.mockResolvedValueOnce({
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command: {
          programArguments: ["node", path.join(root, "openclaw.mjs"), "gateway", "--port", "19431"],
        },
        verdict: { kind: "owned", root, fingerprint: "fixture", refreshDefinition: false },
      });
    }
    vi.mocked(verifyUpdatedGateway).mockImplementationOnce(async ({ gatewayPort }) => {
      const ok = !effectivePort || gatewayPort === 19431;
      return {
        ok,
        summary: ok ? "Gateway version and readiness verified." : "wrong Gateway endpoint",
      };
    });
    const unsafeReason = "state-migration-started";
    if (failure === "thrown") {
      mocks.converge.mockRejectedValueOnce(new Error("plugin finalization failed"));
    } else {
      failedPlugins(unsafe ? { serviceRestartSafe: false, reason: unsafeReason } : undefined);
    }
    const recovery = unsafe
      ? { serviceRestartSafe: false, reason: unsafeReason }
      : { serviceRestartSafe: true, service: "healthy", version: "2026.9.5" };
    await expect(
      finishSuccessfulPackageSwitch({ packageRoot: root, json: true }),
    ).rejects.toMatchObject({
      result: {
        status: "error",
        reason: failure === "thrown" ? "post-update-failed" : "post-update-plugins",
        recovery,
      },
    });
    expect(verifyUpdatedGateway).toHaveBeenCalledOnce();
    if (effectivePort) {
      expect(verifyUpdatedGateway).toHaveBeenCalledWith(
        containing({ gatewayPort: 19431, expectedVersion: "2026.9.5" }),
      );
    } else if (!unsafe) {
      expect(verifyUpdatedGateway).toHaveBeenCalledWith(
        containing({ purpose: "recovery", expectedVersion: "2026.9.5" }),
      );
      expect(mocks.printResult).toHaveBeenCalledWith(
        containing({ recovery }),
        expect.anything(),
        expect.anything(),
      );
    }
  },
);
