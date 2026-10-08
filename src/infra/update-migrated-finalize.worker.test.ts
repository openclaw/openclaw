import { format } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";

const fixture = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  budget: vi.fn(),
  activation: vi.fn(),
  finish: vi.fn(),
  terminal: vi.fn(),
  writeFile: vi.fn(),
  stopService: vi.fn(),
  ownerLease: vi.fn(),
  recordStep: vi.fn(),
  fence: { assertCurrent: vi.fn() },
}));

// Exercise the executable's output boundary without update, service, or database effects.
vi.mock("node:fs/promises", () => ({ default: { writeFile: fixture.writeFile } }));
vi.mock("../cli/daemon-cli.js", () => ({ finishUpdateRun: vi.fn() }));
vi.mock("../cli/runtime-cleanup-scope.js", () => ({
  retainCliProcessJobUntilExit: vi.fn(),
  withCliProcessScope: async (run: () => Promise<void>) => run(),
}));
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  captureUpdateCommandExecutorAuthority: () => ({ installKey: "/synthetic" }),
  withDelegatedUpdateCommandExecutor: async (
    _executor: unknown,
    _runId: string,
    _root: string,
    run: (fence: { assertCurrent: () => void }) => Promise<unknown>,
    options?: { activationTimeoutMs: number },
  ) => {
    fixture.activation(options);
    return run({ assertCurrent: vi.fn() });
  },
  withUpdateCommandExecutor: async (
    _runId: string,
    run: (executor: { enter: () => Promise<typeof fixture.fence> }) => Promise<unknown>,
  ) => run({ enter: async () => fixture.fence }),
}));
vi.mock("../cli/update-cli/update-command-post-update.js", () => ({
  finishUpdate: fixture.finish,
}));
vi.mock("../cli/update-cli/update-command-result.js", () => ({
  formatUpdateFinalizationError: String,
  UpdateCommandFailure: class extends Error {},
}));
vi.mock("../cli/update-cli/update-command-service-maintenance.js", () => ({
  createWindowsTaskAutoStartGuard: vi.fn(),
  maybeStopManagedServiceBeforeMutableUpdate: fixture.stopService,
}));
vi.mock("../state/openclaw-state-db-doctor-schema.js", () => ({
  openDoctorStateSchemaReadAdmission: vi.fn(),
}));
vi.mock("./gateway-owner-lease.js", () => ({ readGatewayOwnerLease: fixture.ownerLease }));
vi.mock("../cli/update-cli/update-command-terminal.js", () => ({
  withUpdateCommandTerminalResult: async (run: (registerRun: () => void) => Promise<unknown>) =>
    run(vi.fn()),
}));
vi.mock("../cli/update-cli/update-command-windows-task.js", () => ({
  createWindowsTaskAutoStartRecovery: vi.fn(),
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseAsync: fixture.close,
}));
vi.mock("./update-finalization-budget.js", () => ({
  resolveUpdateFinalizationTimeoutMs: fixture.budget,
}));
vi.mock("./update-doctor-result.js", () => ({
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV: "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
  recordUpdateDoctorConfigWriteRefusal: vi.fn(),
  writeUpdatePostInstallDoctorResult: vi.fn(),
}));
vi.mock("./update-requester-authority.js", () => ({
  createManagedUpdateRequesterAuthority: vi.fn(),
  UpdateRequesterRevokedError: class extends Error {},
}));
vi.mock("./update-run-ledger.js", () => ({
  adoptUpdateRun: vi.fn(),
  getUpdateRun: fixture.terminal,
}));
vi.mock("./update-run-write.async.js", () => ({ recordUpdateRunStepAsync: fixture.recordStep }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalRouting = loggingState.forceConsoleToStderr;
const originalConsole = loggingState.rawConsole;
const stdout: string[] = [];
const stderr: string[] = [];
const result = { status: "ok", mode: "npm", steps: [], durationMs: 0 };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  stdout.length = 0;
  stderr.length = 0;
  loggingState.forceConsoleToStderr = false;
  loggingState.rawConsole = {
    log: (...args) => stdout.push(`${format(...args)}\n`),
    info: (...args) => stdout.push(`${format(...args)}\n`),
    warn: (...args) => stderr.push(`${format(...args)}\n`),
    error: (...args) => stderr.push(`${format(...args)}\n`),
  };
  setLoggerOverride({ level: "silent", consoleLevel: "debug", consoleStyle: "compact" });
  vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    stdout.push(String(value));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    stderr.push(String(value));
    return true;
  });
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  loggingState.forceConsoleToStderr = originalRouting;
  loggingState.rawConsole = originalConsole;
  setLoggerOverride(null);
  vi.restoreAllMocks();
});

async function runWorker(
  input: unknown,
  mode?: "--check" | "--doctor",
  cleanup?: () => Promise<void>,
) {
  const settled = createDeferredCore();
  fixture.close.mockImplementation(async () => {
    await cleanup?.();
    settled.resolve();
  });
  process.argv = [process.execPath, "update-migrated-finalize.worker.js", ...(mode ? [mode] : [])];
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield JSON.stringify(input);
    return undefined;
  });
  await import("./update-migrated-finalize.worker.js");
  await settled.promise;
}

it.each(["json", "human", "check"] as const)(
  "preserves %s stdout through finalization and asynchronous cleanup",
  async (mode) => {
    const log = createSubsystemLogger("state/sqlite");
    fixture.budget.mockImplementation(async () => {
      log.debug("activation budget diagnostic");
      return 300_000;
    });
    fixture.finish.mockImplementation(async () => {
      if (mode === "json") {
        defaultRuntime.writeJson(result);
      } else {
        process.stdout.write("Update complete\n");
      }
      return result;
    });
    fixture.terminal.mockImplementation(() => {
      log.debug("terminal snapshot diagnostic");
      return { runId: "synthetic-run", status: "ok" };
    });
    await runWorker(
      {
        executor: {},
        bufferedSteps: [],
        resultPath: "/synthetic/result.json",
        params: {
          root: "/synthetic",
          opts: { json: mode === "json", run: { runId: "synthetic-run", env: {} } },
          rollbackBlockedReason: "state-migrated-no-rollback",
          preUpdatePluginInstallRecords: {},
          result,
        },
      },
      mode === "check" ? "--check" : undefined,
      async () => {
        await Promise.resolve();
        log.debug("cleanup diagnostic");
      },
    );

    expect(process.exitCode).toBe(originalExitCode);
    if (mode === "human") {
      expect(stdout.join("")).toContain("Update complete\n");
      expect(stdout.join("")).toContain("terminal snapshot diagnostic");
      expect(stderr).toEqual([]);
    } else {
      expect(JSON.parse(stdout.join(""))).toMatchObject(
        mode === "json"
          ? result
          : { executorDelegation: "pid-start-v1", postCoreExecutor: "stdin-pid-start-v1" },
      );
      expect(stderr.join("")).toContain("cleanup diagnostic");
      if (mode === "json") {
        expect(stderr.join("")).toContain("activation budget diagnostic");
        expect(stderr.join("")).toContain("terminal snapshot diagnostic");
      }
    }
  },
);

it.each([false, true])(
  "binds migrated worker finalization to its local candidate runtime (restart pending=%s)",
  async (restartPending) => {
    const env = Object.fromEntries(
      ["TMPDIR", "TMP", "TEMP"].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]]],
      ),
    );
    const input = {
      params: {
        root: "/fixture/candidate",
        result: {
          status: "ok",
          mode: "npm",
          root: "/fixture/candidate",
          runId: "candidate-run",
          steps: [],
          durationMs: 0,
        },
        opts: {
          json: true,
          run: {
            runId: "candidate-run",
            env,
            activationTimeoutMs: 1_000,
            ...(restartPending
              ? { completionOwner: "gateway-restart" as const, gatewayRestartRequired: true }
              : {}),
          },
        },
        preUpdatePluginInstallRecords: {},
        updateStepTimeoutMs: 1_000,
        rollbackBlockedReason: "state-migrated-no-rollback",
      },
      bufferedSteps: [],
      resultPath: "/fixture/result.json",
    };
    fixture.finish.mockImplementation(async (_params, options) => {
      if (restartPending) {
        options.onGatewayStartAttempted?.();
      }
      return input.params.result;
    });
    fixture.terminal.mockReturnValue({
      runId: "candidate-run",
      status: restartPending ? "running" : "succeeded",
      phase: restartPending ? "restarting" : "finished",
    });
    await runWorker(input);

    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(
      {
        ...input.params,
        opts: {
          ...input.params.opts,
          run: { ...input.params.opts.run, executorFence: fixture.fence },
        },
      },
      { candidateRuntime: true, onGatewayStartAttempted: expect.any(Function) },
    );
    expect(fixture.fence.assertCurrent).toHaveBeenCalled();
    expect(fixture.writeFile).toHaveBeenCalledExactlyOnceWith(
      input.resultPath,
      JSON.stringify({
        result: input.params.result,
        exitCode: 0,
        candidateStartAttempted: restartPending,
        ...(restartPending
          ? { restartRunId: "candidate-run" }
          : { terminalRunId: "candidate-run" }),
        executorDelegation: "pid-start-v1",
      }),
      { mode: 0o600 },
    );
  },
);

it.each([
  {
    name: "supported omission",
    version: 1,
    operator: null,
    owner: "parent",
    serialized: "1800",
    expected: undefined,
  },
  {
    name: "supported omission with foreground restart pending",
    version: 1,
    operator: null,
    owner: "parent",
    serialized: "1800",
    restartPending: true,
    expected: undefined,
  },
  {
    name: "explicit deadline",
    version: 1,
    operator: "1800",
    owner: "parent",
    serialized: "1800",
    expected: 10_800_000,
  },
  {
    name: "unknown version",
    version: 2,
    operator: null,
    owner: "parent",
    serialized: "1800",
    expected: 10_800_000,
  },
  {
    name: "mismatched serialization",
    version: 1,
    operator: null,
    owner: "parent",
    serialized: "900",
    expected: 10_800_000,
  },
  {
    name: "malformed operator",
    version: 1,
    operator: false,
    owner: "parent",
    serialized: "1800",
    expected: 10_800_000,
  },
  {
    name: "wrong completion owner",
    version: 1,
    operator: null,
    owner: "child",
    serialized: "1800",
    expected: 10_800_000,
  },
  { name: "legacy producer", expected: 10_800_000 },
  {
    name: "inherited explicit allowance",
    version: 1,
    operator: null,
    owner: "parent",
    serialized: "1800",
    inherited: 12_345,
    expected: 12_345,
  },
])("preserves aggregate deadline intent for $name", async (row) => {
  const input = {
    executor: {},
    completionOwner: row.owner,
    timeout:
      row.version === undefined
        ? undefined
        : {
            version: row.version,
            serialized: row.serialized,
            operator: row.operator,
          },
    bufferedSteps: [],
    resultPath: "/synthetic/result.json",
    params: {
      root: "/synthetic",
      opts: {
        json: true,
        timeout: row.version === undefined ? undefined : "1800",
        run: {
          runId: "synthetic-run",
          env: {},
          activationTimeoutMs: row.inherited,
          ...(row.restartPending
            ? { completionOwner: "gateway-restart", gatewayRestartRequired: true }
            : {}),
        },
      },
      updateStepTimeoutMs: 1_800_000,
      rollbackBlockedReason: "state-migrated-no-rollback",
      preUpdatePluginInstallRecords: {},
      result: { ...result, runId: "synthetic-run" },
    },
  };
  fixture.budget.mockResolvedValue(10_800_000);
  fixture.finish.mockResolvedValue(input.params.result);
  fixture.terminal.mockReturnValue({
    runId: "synthetic-run",
    status: row.restartPending ? "running" : "succeeded",
    ...(row.restartPending ? { phase: "restarting" } : {}),
  });
  await runWorker(input);

  expect(process.exitCode).toBe(originalExitCode);
  expect(fixture.activation).toHaveBeenCalledExactlyOnceWith(
    row.expected === undefined ? undefined : { activationTimeoutMs: row.expected },
  );
  expect(fixture.budget).toHaveBeenCalledTimes(
    row.expected === undefined || row.inherited !== undefined ? 0 : 1,
  );
  expect(fixture.finish).toHaveBeenCalledOnce();
  expect(fixture.writeFile).toHaveBeenCalledOnce();
  if (row.restartPending) {
    expect(fixture.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({ timeout: undefined }),
      }),
      { candidateRuntime: true, onGatewayStartAttempted: expect.any(Function) },
    );
    expect(fixture.writeFile).toHaveBeenCalledWith(
      input.resultPath,
      JSON.stringify({
        result: input.params.result,
        exitCode: 0,
        candidateStartAttempted: true,
        restartRunId: "synthetic-run",
        executorDelegation: "pid-start-v1",
      }),
      { mode: 0o600 },
    );
  }
});

it.each(["inspected", "legacy-unavailable", "windows-suspended"] as const)(
  "forwards the %s service owner to shared migrated finalization",
  async (mode) => {
    const transferred =
      mode === "legacy-unavailable"
        ? {
            stopped: false,
            inspected: false,
            serviceMutationAllowed: false,
            serviceUpdateVerdict: { kind: "unavailable", message: "legacy inspection unavailable" },
          }
        : {
            stopped: mode === "windows-suspended",
            inspected: true,
            runtimeInspected: true,
            running: true,
            servicePid: 631,
            serviceEnv: { OPENCLAW_PROFILE: "selected" },
            serviceManagerUid: 1000,
            serviceUpdateVerdict: { kind: "owned", root: "/synthetic", fingerprint: "f" },
          };
    const input = {
      executor: {},
      bufferedSteps: [],
      resultPath: "/synthetic/result.json",
      ...(mode === "windows-suspended" ? { windowsTaskAutoStartSuspended: true } : {}),
      params: {
        root: "/synthetic",
        shouldRestart: false,
        updateStepTimeoutMs: 1_000,
        opts: { json: true, run: { runId: "synthetic-run", env: {}, activationTimeoutMs: 1_000 } },
        rollbackBlockedReason: "state-migrated-no-rollback",
        preUpdatePluginInstallRecords: {},
        preManagedServiceStop: transferred,
        result: { ...result, steps: [], runId: "synthetic-run" },
      },
    };
    fixture.finish.mockImplementation(async (params: { result: typeof result }) => params.result);
    fixture.terminal.mockReturnValue({ runId: "synthetic-run", status: "succeeded", steps: [] });
    await runWorker(input);

    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        shouldRestart: false,
        preManagedServiceStop: { ...transferred, windowsTaskAutoStartRecovery: undefined },
      }),
      { candidateRuntime: true, onGatewayStartAttempted: expect.any(Function) },
    );
    expect(fixture.stopService).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  },
);

it.each([
  {
    name: "stops a live supervised predecessor",
    owner: { state: "live", mode: "supervised" },
    stops: true,
    uncertain: false,
  },
  {
    name: "does not enter Doctor after an uncertain native stop",
    owner: { state: "live", mode: "supervised" },
    stops: true,
    uncertain: true,
  },
  {
    name: "leaves a foreground owner to Doctor's own wait",
    owner: { state: "live", mode: "foreground" },
    stops: false,
  },
  { name: "does nothing without an owner", owner: undefined, stops: false },
])("delegated Doctor $name before entering maintenance", async ({ owner, stops, uncertain }) => {
  const doctor = vi.fn();
  vi.doMock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: doctor }));
  fixture.ownerLease.mockReturnValue(owner);
  fixture.recordStep.mockImplementation(async (runId: string, step: unknown) => ({
    runId,
    status: "running",
    steps: [step],
  }));
  const stoppedState = {
    stopped: true,
    stoppedAtMs: 7,
    inspected: true,
    runtimeInspected: true,
    running: true,
    servicePid: 631,
    serviceManagerUid: 1000,
    serviceUpdateVerdict: { kind: "owned", root: "/synthetic", fingerprint: "f" },
  };
  fixture.stopService.mockImplementation(async (params: { onStopped?: (s: unknown) => void }) => {
    params.onStopped?.(stoppedState);
    throw uncertain
      ? new CommandProcessCleanupError()
      : new Error("port still bound after bootout");
  });
  process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = "/synthetic/doctor.json";
  try {
    await runWorker(
      {
        executor: {},
        runId: "synthetic-run",
        root: "/synthetic",
        configInputHash: "hash",
        repair: true,
        databaseGenerations: { "/synthetic/agent.sqlite": null },
      },
      "--doctor",
    );
  } finally {
    delete process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
    vi.doUnmock("../flows/doctor-health.js");
  }

  if (uncertain) {
    expect(doctor).not.toHaveBeenCalled();
  } else {
    expect(doctor, stderr.join("\n")).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ databaseGenerations: { "/synthetic/agent.sqlite": null } }),
    );
  }
  if (stops) {
    expect(fixture.stopService).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ root: "/synthetic", phase: "prepare", shouldRestart: true }),
    );
    // The receipt is a retained `finalize:` step whose key carries the identity,
    // so published parents' detail compaction cannot erase it.
    expect(fixture.recordStep).toHaveBeenCalledExactlyOnceWith(
      "synthetic-run",
      {
        step: "finalize:predecessor-stop:7:1000:631:f",
        status: "completed",
        endedAtMs: 7,
      },
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    if (!uncertain) {
      expect(fixture.stopService.mock.invocationCallOrder[0]).toBeLessThan(
        doctor.mock.invocationCallOrder[0] ?? 0,
      );
    }
  } else {
    expect(fixture.stopService).not.toHaveBeenCalled();
  }
});
