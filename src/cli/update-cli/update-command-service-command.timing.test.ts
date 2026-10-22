import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { recordServiceTimedStep } from "./update-command-result.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import type { UpdateServiceDefinitionRecovery } from "./update-command-service-context-types.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  recordStep: vi.fn(),
}));

vi.mock(import("../../daemon/gateway-entrypoint.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGatewayInstallEntrypoint: async () => "/fixture/root/dist/entry.js",
}));
vi.mock(import("../../process/exec.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  runCommandWithTimeout: mocks.command,
}));
vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-executor.js")>()),
  requiresRetainedUpdateCommandOwner: () => false,
  withUpdateCommandExecutorChild: async (
    _executor: unknown,
    _root: string,
    run: (grant: object, bindChild: () => void) => Promise<unknown>,
  ) => await run({ token: "grant" }, () => {}),
}));
vi.mock(import("../../infra/update-run-ledger.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  recordUpdateRunStep: mocks.recordStep,
}));

beforeEach(() => {
  vi.useFakeTimers({ now: 1_791_595_070_000 });
  mocks.command.mockReset();
  mocks.recordStep.mockReset();
});

afterEach(() => vi.useRealTimers());

type InstallParams = Parameters<typeof runUpdatedInstallGatewayCommand>[0];
const runInstall = (overrides: Partial<InstallParams> = {}) =>
  runUpdatedInstallGatewayCommand(
    { result: { root: "/fixture/root", mode: "npm" }, opts: {}, invocationEnv: {}, ...overrides },
    "install",
  );
const executorOptions = () => ({
  run: { runId: "run-1", env: {}, executorFence: { assertCurrent() {} } },
});
const probeResult = (definitionBackup?: boolean) =>
  createCommandResult({
    code: 0,
    cleanup: "normal",
    stdout: JSON.stringify({
      updateExecutor: GATEWAY_UPDATE_EXECUTOR_CONTRACT,
      targetRootBinding: true,
      ...(definitionBackup === undefined ? {} : { definitionBackup }),
    }),
  });
const timedStep = (phase: string, args: string, durationMs: number): UpdateStepResult => ({
  name: `managed-service-${phase}`,
  command: `openclaw gateway ${args}`,
  cwd: "/fixture/root",
  durationMs,
  exitCode: 0,
});

it("times the executor probe separately from the reconciliation install child", async () => {
  mocks.command.mockImplementation(async (argv: string[]) => {
    if (argv.includes("check")) {
      vi.advanceTimersByTime(9_000);
      return probeResult();
    }
    vi.advanceTimersByTime(24_000);
    return createCommandResult({
      code: 0,
      stdout: JSON.stringify({ action: "install", ok: true }),
    });
  });
  const steps: UpdateStepResult[] = [];
  const onGatewayStartAttempted = vi.fn();
  await expect(
    runInstall({
      result: { root: "/fixture/root", mode: "git" },
      opts: executorOptions(),
      nodeRunner: "node",
      gatewayPort: 18809,
      onGatewayStartAttempted,
      onTimedStep: (step) => steps.push(step),
    }),
  ).resolves.toBe("unverified");

  expect(onGatewayStartAttempted).toHaveBeenCalledExactlyOnceWith("install");
  expect(steps).toEqual([
    timedStep("executor-check", "install --update-executor check --json", 9_000),
    timedStep("install", "install --force --port 18809 --json", 24_000),
  ]);
});

it("keeps failed reconciliation children on the existing failure path", async () => {
  mocks.command.mockImplementation(async () => {
    vi.advanceTimersByTime(5_000);
    return createCommandResult({ code: 1, stderr: "install refused" });
  });
  const onTimedStep = vi.fn();

  await expect(runInstall({ onTimedStep })).rejects.toThrow("install refused");
  expect(onTimedStep).not.toHaveBeenCalled();
});

it.each(["", "UPDATE_NATIVE_AUTHORITY: exit 1"])(
  "classifies a completed pre-write refusal with stderr %j",
  async (stderr) => {
    const error =
      "SERVICE_DEFINITION_UNKNOWN: Service definition inspection or backup failed; the definition was preserved: inspection failed";
    mocks.command.mockImplementation(async (argv: string[]) =>
      argv.includes("check")
        ? probeResult(true)
        : createCommandResult({
            code: 1,
            stdout: JSON.stringify({ action: "install", ok: false, error }),
            stderr,
          }),
    );
    const definitionRecovery: UpdateServiceDefinitionRecovery = {};
    const failure = await runInstall({ opts: executorOptions(), definitionRecovery }).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof UpdateCommandRecoveryPendingError).toBe(stderr !== "");
    expect(failure).toHaveProperty(
      "message",
      `updated install refresh failed: ${stderr || error} (/fixture/root/dist/entry.js)`,
    );
    expect(definitionRecovery).toEqual({ preserved: true, unverified: false });
  },
);

it.each([false, true])("retains a timed step when history write fails=%s", (failed) => {
  if (failed) {
    mocks.recordStep.mockImplementation(() => {
      throw new Error("database is locked");
    });
  }
  const result: UpdateRunResult = { status: "ok", mode: "git", steps: [], durationMs: 0 };
  const step = timedStep("install", "install --force --json", 24_000);
  const run = { runId: "run-1", env: {}, busyTimeoutMs: 71_000 };
  expect(() => recordServiceTimedStep(result, step, run)).not.toThrow();
  expect(result.steps).toEqual([step]);
  if (!failed) {
    expect(mocks.recordStep).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      expect.objectContaining({
        step: "managed-service-install",
        status: "completed",
        startedAtMs: Date.now() - 24_000,
        endedAtMs: Date.now(),
      }),
      run,
    );
  }
});
