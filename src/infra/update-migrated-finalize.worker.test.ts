import { setImmediate } from "node:timers/promises";
import { format } from "node:util";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import type { MigratedUpdateFinalizationInput } from "../cli/update-cli/update-command-migrated-types.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  getDatabaseProcessRole,
  installDatabaseProcessRole,
} from "./database-engine/admission-scope.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import {
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
} from "./update-post-core-context.js";

it.each([false, true])(
  "validates the internal retirement-only hint (%s)",
  async (retirementOnly) => {
    const doctor = vi.fn();
    // mock-isolation: Observe the private wire contract without running host maintenance.
    vi.doMock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: doctor }));
    process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = "/synthetic/doctor.json";
    try {
      await runWorker(
        {
          executor: {},
          runId: "synthetic-run",
          root: "/synthetic",
          configInputHash: "hash",
          repair: true,
          retirementOnly,
        },
        "--doctor",
      );
    } finally {
      delete process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
      vi.doUnmock("../flows/doctor-health.js");
    }

    expect(fixture.stopService).not.toHaveBeenCalled();
    if (retirementOnly) {
      expect(doctor).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ retirementOnly: true }),
      );
      expect(process.exitCode).toBe(originalExitCode);
    } else {
      expect(doctor).not.toHaveBeenCalled();
      expect(fixture.activation).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(stderr.join("")).toContain("retirementOnly");
    }
  },
);

const fixture = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  closeNative: vi.fn<() => Promise<void>>(),
  closePostgres: vi.fn<() => Promise<void>>(),
  budget: vi.fn(),
  activation: vi.fn(),
  finish: vi.fn(),
  terminal: vi.fn(),
  writeFile: vi.fn(),
  stopService: vi.fn(),
  ownerLease: vi.fn(),
  recordStep: vi.fn(),
  recordLedgerStep: vi.fn(),
  adopt: vi.fn(),
  fence: { assertCurrent: vi.fn() },
}));

vi.mock("./database-engine/admission-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./database-engine/admission-scope.js")>();
  return { ...actual, installDatabaseProcessRole: vi.fn(actual.installDatabaseProcessRole) };
});

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
// mock-isolation: Finalizer fixtures observe cleanup without closing the test process's native workers.
vi.mock("./worker-native-lifecycle.js", () => ({
  closeDefaultRetainedNativeWorkerSource: fixture.closeNative,
}));
// mock-isolation: Keep executable cleanup scoped to the synthetic finalization fixture.
vi.mock("./postgres-sync/pool.js", () => ({
  preparePostgresPoolForUpdate: vi.fn(async () => {}),
  closePostgresPool: fixture.closePostgres,
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
// mock-isolation: Worker lifecycle tests replace ledger access without opening a real state database.
vi.mock("./update-run-ledger.js", () => ({
  adoptUpdateRun: fixture.adopt,
  getUpdateRun: fixture.terminal,
  recordUpdateRunStep: fixture.recordLedgerStep,
}));
vi.mock("./update-run-write.async.js", () => ({ recordUpdateRunStepAsync: fixture.recordStep }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const originalRouting = loggingState.forceConsoleToStderr;
const originalConsole = loggingState.rawConsole;
const stdout: string[] = [];
const stderr: string[] = [];
const result = { status: "ok", mode: "npm", steps: [], durationMs: 0 };
const finalizationOptions = {
  candidateRuntime: true,
  adoptedFinalization: true,
  onGatewayStartAttempted: expect.any(Function),
};
function finalizationParams(
  run: Partial<NonNullable<UpdateCommandOptions["run"]>> = {},
  root = "/synthetic",
  opts: Pick<UpdateCommandOptions, "json" | "timeout"> = {},
) {
  const runId = run.runId ?? "synthetic-run";
  return {
    root,
    opts: { json: true, ...opts, run: { runId, env: {}, activationTimeoutMs: 1_000, ...run } },
    rollbackBlockedReason: "state-migrated-no-rollback",
    preUpdatePluginInstallRecords: {},
    updateStepTimeoutMs: 1_000,
    result: { ...result, steps: [], runId },
  };
}
function workerInput<T>(params: T) {
  return { executor: {}, bufferedSteps: [], resultPath: "/synthetic/result.json", params };
}
function expectResultFile(
  input: { resultPath: string; params: { result: unknown } },
  restartPending: boolean,
  runId: string,
) {
  const args = [
    input.resultPath,
    JSON.stringify({
      result: input.params.result,
      exitCode: 0,
      candidateStartAttempted: restartPending,
      ...(restartPending ? { restartRunId: runId } : { terminalRunId: runId }),
      executorDelegation: "pid-start-v1",
    }),
    { mode: 0o600 },
  ];
  expect(fixture.writeFile).toHaveBeenCalledExactlyOnceWith(...args);
}

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
  mode?: "--check" | "--doctor" | "--post-core",
  cleanup?: () => Promise<void>,
  nativeCleanup?: () => Promise<void>,
) {
  const settled = createDeferredCore();
  fixture.close.mockImplementation(async () => cleanup?.());
  fixture.closeNative.mockImplementation(async () => {
    try {
      await nativeCleanup?.();
    } finally {
      settled.resolve();
    }
  });
  fixture.closePostgres.mockResolvedValue(undefined);
  process.argv = [process.execPath, "update-migrated-finalize.worker.js", ...(mode ? [mode] : [])];
  vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
    yield JSON.stringify(input);
    return undefined;
  });
  await import("./update-migrated-finalize.worker.js");
  await settled.promise;
  await setImmediate();
}

async function runDoctorWorker(
  doctor: ReturnType<typeof vi.fn>,
  input: object,
  beforeImport = () => {},
) {
  // mock-isolation: Retain the flow's exports while keeping repairs inside this fixture.
  vi.doMock("../flows/doctor-health.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../flows/doctor-health.js")>();
    beforeImport();
    return { ...actual, runDoctorHealthFlow: doctor };
  });
  vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", "/synthetic/doctor.json");
  try {
    await runWorker(
      {
        executor: {},
        runId: "synthetic-run",
        root: "/synthetic",
        configInputHash: "hash",
        repair: true,
        ...input,
      },
      "--doctor",
    );
  } finally {
    vi.unstubAllEnvs();
    vi.doUnmock("../flows/doctor-health.js");
  }
}

it("installs the one-shot database role before delegated Doctor maintenance", async () => {
  const doctor = vi.fn(() => {
    expect(installDatabaseProcessRole).toHaveBeenCalledExactlyOnceWith("cli-oneshot");
    expect(getDatabaseProcessRole()).toBe("cli-oneshot");
  });
  await runDoctorWorker(doctor, {});
  expect(doctor).toHaveBeenCalledOnce();
  expect(process.exitCode, stderr.join("")).toBe(originalExitCode);
});

it.each(["database", "native"] as const)(
  "retains PostgreSQL services when the %s owner drain rejects",
  async (owner) => {
    const failure = new Error(`${owner} drain failed`);
    const reject = async () => {
      throw failure;
    };
    await runWorker(
      {},
      "--check",
      owner === "database" ? reject : undefined,
      owner === "native" ? reject : undefined,
    );

    expect(fixture.close).toHaveBeenCalledOnce();
    expect(fixture.closeNative).toHaveBeenCalledOnce();
    expect(fixture.closePostgres).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain(failure.message);
  },
);

it("keeps live callbacks and deadline owners out of the migrated wire contract", () => {
  type Options = MigratedUpdateFinalizationInput["params"]["opts"];
  expectTypeOf<Options>().not.toHaveProperty("onResult");
  expectTypeOf<NonNullable<Options["run"]>>().not.toHaveProperty("deadline");
});

it("refuses a malformed post-core timeout before invoking the updater", async () => {
  const update = vi.fn();
  // mock-isolation: Check input rejection without running package updates against the host.
  vi.doMock("../cli/update-cli/update-command.js", () => ({ updateCommand: update }));
  vi.stubEnv(POST_CORE_UPDATE_ENV, "1");
  vi.stubEnv(POST_CORE_UPDATE_RESULT_PATH_ENV, "/synthetic/post-core.json");
  vi.stubEnv(UPDATE_RUN_ID_ENV, "synthetic-run");
  try {
    await runWorker(
      {
        executor: {},
        runId: "synthetic-run",
        root: process.cwd(),
        opts: { timeout: 42 },
      },
      "--post-core",
    );
    await setImmediate();
  } finally {
    vi.unstubAllEnvs();
    vi.doUnmock("../cli/update-cli/update-command.js");
  }

  expect(update).not.toHaveBeenCalled();
  expect(fixture.activation).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(stderr.join("")).toContain("timeout");
  expect(fixture.closePostgres).toHaveBeenCalledOnce();
});

it.each([
  { field: "repair", value: "false" },
  { field: "requester", value: { senderId: 42 } },
  { field: "databaseGenerations", value: { "/synthetic/agent.sqlite": false } },
])("refuses malformed Doctor $field before maintenance", async ({ field, value }) => {
  const doctor = vi.fn();
  await runDoctorWorker(doctor, { [field]: value });
  // The executable reports its terminal error after all cleanup promises settle.
  await setImmediate();

  expect(doctor).not.toHaveBeenCalled();
  expect(fixture.stopService).not.toHaveBeenCalled();
  expect(fixture.activation).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(stderr.join("")).toContain(field);
});

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
      workerInput({
        ...finalizationParams({ activationTimeoutMs: undefined }, "/synthetic", {
          json: mode === "json",
        }),
        updateStepTimeoutMs: undefined,
        result,
      }),
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
          : {
              executorDelegation: "pid-start-v1",
              postCoreExecutor: "stdin-pid-start-v1",
              pluginCohortSettlement: true,
            },
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
      ...workerInput({
        ...finalizationParams(
          {
            runId: "candidate-run",
            env,
            ...(restartPending
              ? { completionOwner: "gateway-restart", gatewayRestartRequired: true }
              : {}),
          },
          "/fixture/candidate",
        ),
        result: { ...result, root: "/fixture/candidate", runId: "candidate-run" },
      }),
      executor: undefined,
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

    const expected = structuredClone(input.params);
    Object.assign(expected.opts.run, { executorFence: fixture.fence, busyTimeoutMs: 1_000 });
    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(expected, finalizationOptions);
    expect(fixture.fence.assertCurrent).toHaveBeenCalled();
    expectResultFile(input, restartPending, "candidate-run");
  },
);

it("times the fresh-driver handoff from the previous driver's last receipt", async () => {
  const handoffStartedAtMs = 1_791_594_640_455;
  const readyAtMs = handoffStartedAtMs + 23_400;
  vi.spyOn(Date, "now").mockReturnValue(readyAtMs);
  fixture.adopt.mockReturnValueOnce({
    runId: "handoff-run",
    steps: [
      { step: "validating", status: "completed", endedAtMs: handoffStartedAtMs - 10_000 },
      { step: "driver:adopted", status: "completed", endedAtMs: handoffStartedAtMs + 15_494 },
    ],
  });
  const steps: unknown[] = [];
  const input = {
    ...workerInput({
      ...finalizationParams({ runId: "handoff-run" }, "/fixture/candidate"),
      result: { status: "ok", mode: "git", root: "/fixture/candidate", steps, durationMs: 0 },
    }),
    executor: undefined,
    bufferedSteps: [
      {
        step: "git-verify-head",
        status: "completed",
        startedAtMs: handoffStartedAtMs - 36,
        endedAtMs: handoffStartedAtMs,
        exitCode: 0,
      },
    ],
    resultPath: "/fixture/result.json",
  };
  let stepsAtFinish: unknown[] = [];
  fixture.finish.mockImplementation(async (params) => {
    stepsAtFinish = [...params.result.steps];
    return input.params.result;
  });
  fixture.terminal.mockReturnValue({ runId: "handoff-run", status: "succeeded" });

  await runWorker(input);

  const handoff = {
    name: "update-driver-handoff",
    command: "openclaw update",
    cwd: "/fixture/candidate",
    durationMs: 23_400,
    exitCode: 0,
    diagnostics: [
      'Handoff began after "git-verify-head"; the fresh driver adopted the run after 15494ms.',
    ],
  };
  expect(stepsAtFinish).toEqual([handoff]);
  expect(fixture.recordStep).toHaveBeenCalledWith(
    "handoff-run",
    input.bufferedSteps[0],
    expect.anything(),
  );
  expect(fixture.recordLedgerStep.mock.calls).toEqual(
    [
      { step: "update-driver-handoff", status: "completed" },
      { step: "diagnostic:update-driver-handoff", detail: handoff.diagnostics[0] },
    ].map((step) => [
      "handoff-run",
      expect.objectContaining({ ...step, startedAtMs: handoffStartedAtMs, endedAtMs: readyAtMs }),
      expect.objectContaining({ env: {}, busyTimeoutMs: 1_000 }),
    ]),
  );
});

type DeadlineCase = [
  name: string,
  version: number | undefined,
  operator: string | boolean | null | undefined,
  owner: string | undefined,
  serialized: string | undefined,
  expected: number | undefined,
  restartPending?: boolean,
  inherited?: number,
];
it.each<DeadlineCase>([
  ["supported omission", 1, null, "parent", "1800", undefined],
  ["omission during restart", 1, null, "parent", "1800", undefined, true],
  ["explicit deadline", 1, "1800", "parent", "1800", 10_800_000],
  ["unknown version", 2, null, "parent", "1800", 10_800_000],
  ["mismatched serialization", 1, null, "parent", "900", 10_800_000],
  ["malformed operator", 1, false, "parent", "1800", 10_800_000],
  ["wrong completion owner", 1, null, "child", "1800", 10_800_000],
  ["legacy producer", undefined, undefined, undefined, undefined, 10_800_000],
  ["inherited explicit allowance", 1, null, "parent", "1800", 12_345, false, 12_345],
])(
  "preserves aggregate deadline intent for %s",
  async (_name, version, operator, owner, serialized, expected, restartPending, inherited) => {
    const input = {
      ...workerInput({
        ...finalizationParams(
          {
            activationTimeoutMs: inherited,
            ...(restartPending
              ? { completionOwner: "gateway-restart", gatewayRestartRequired: true }
              : {}),
          },
          "/synthetic",
          { timeout: version === undefined ? undefined : "1800" },
        ),
        updateStepTimeoutMs: 1_800_000,
      }),
      completionOwner: owner,
      timeout: version === undefined ? undefined : { version, serialized, operator },
    };
    fixture.budget.mockResolvedValue(10_800_000);
    fixture.finish.mockResolvedValue(input.params.result);
    fixture.terminal.mockReturnValue({
      runId: "synthetic-run",
      status: restartPending ? "running" : "succeeded",
      ...(restartPending ? { phase: "restarting" } : {}),
    });
    await runWorker(input);

    expect(process.exitCode).toBe(originalExitCode);
    expect(fixture.activation).toHaveBeenCalledExactlyOnceWith(
      expected === undefined ? undefined : { activationTimeoutMs: expected },
    );
    expect(fixture.budget).toHaveBeenCalledTimes(
      expected === undefined || inherited !== undefined ? 0 : 1,
    );
    expect(fixture.finish).toHaveBeenCalledOnce();
    expect(fixture.writeFile).toHaveBeenCalledOnce();
    if (restartPending) {
      expect(fixture.finish).toHaveBeenCalledWith(
        expect.objectContaining({ opts: expect.objectContaining({ timeout: undefined }) }),
        finalizationOptions,
      );
      expectResultFile(input, true, "synthetic-run");
    }
  },
);

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
      ...workerInput({
        ...finalizationParams(),
        shouldRestart: false,
        preManagedServiceStop: transferred,
      }),
      ...(mode === "windows-suspended" ? { windowsTaskAutoStartSuspended: true } : {}),
    };
    fixture.finish.mockImplementation(async (params: { result: typeof result }) => params.result);
    fixture.terminal.mockReturnValue({ runId: "synthetic-run", status: "succeeded", steps: [] });
    await runWorker(input);

    expect(fixture.finish).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        shouldRestart: false,
        preManagedServiceStop: { ...transferred, windowsTaskAutoStartRecovery: undefined },
      }),
      finalizationOptions,
    );
    expect(fixture.stopService).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(originalExitCode);
  },
);

it("does not stop a supervised predecessor when the delegated Doctor deadline expires during startup", async () => {
  const doctor = vi.fn();
  let wallNow = 1_000;
  let elapsedMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  const deadlineAtMs = wallNow + 500;
  const errorReported = createDeferredCore();
  vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    stderr.push(String(value));
    errorReported.resolve();
    return true;
  });
  vi.spyOn(Date, "now").mockImplementation(() => wallNow);
  fixture.ownerLease.mockReturnValue({ state: "live", mode: "supervised" });
  await runDoctorWorker(doctor, { serviceInspectionDeadlineAtMs: deadlineAtMs }, () => {
    wallNow -= 90_000;
    elapsedMs = 501;
  });
  // Database cleanup settles before the executable reports its terminal error.
  await errorReported.promise;

  expect(fixture.stopService).not.toHaveBeenCalled();
  expect(doctor).not.toHaveBeenCalled();
  expect(stderr.join("")).toContain("Doctor service-inspection deadline has expired.");
  expect(process.exitCode).toBe(1);
});

it.each([
  ["supervised", "stopped"],
  ["supervised", "port-bound"],
  ["supervised", "uncertain"],
  ["foreground", "stopped"],
  [undefined, "stopped"],
] as const)(
  "delegated Doctor respects %s owner and stop=%s before maintenance",
  async (mode, stop) => {
    const uncertain = stop === "uncertain";
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.spyOn(performance, "now").mockReturnValue(0);
    const owner = mode ? { state: "live", mode } : undefined;
    const stops = mode === "supervised";
    const doctor = vi.fn();
    const databasePluginOwners = {
      fixture: {
        id: "fixture",
        rootDir: "/synthetic/plugin",
        source: "/synthetic/plugin/index.ts",
        origin: "bundled",
      },
    };
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
      if (stop === "stopped") {
        return stoppedState;
      }
      throw uncertain
        ? new CommandProcessCleanupError()
        : new Error("port still bound after bootout");
    });
    await runDoctorWorker(doctor, {
      fullIntegrityCheck: true,
      databaseGenerations: { "/synthetic/agent.sqlite": null },
      databasePluginOwners,
      serviceInspectionDeadlineAtMs: 1_500,
    });

    if (uncertain) {
      expect(doctor).not.toHaveBeenCalled();
    } else {
      expect(doctor, stderr.join("\n")).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({ fullIntegrityCheck: true }),
        expect.objectContaining({
          databaseGenerations: { "/synthetic/agent.sqlite": null },
          databasePluginOwners,
        }),
      );
    }
    if (stops) {
      expect(fixture.stopService).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          root: "/synthetic",
          phase: "prepare",
          shouldRestart: true,
          timeoutMs: 500,
        }),
      );
      // The receipt is a retained `finalize:` step whose key carries the identity,
      // so published parents' detail compaction cannot erase it.
      expect(fixture.recordStep).toHaveBeenCalledExactlyOnceWith(
        "synthetic-run",
        { step: "finalize:predecessor-stop:7:1000:631:f", status: "completed", endedAtMs: 7 },
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
  },
);
