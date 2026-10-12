import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as GatewayEntrypoint from "../../daemon/gateway-entrypoint.js";
import { GATEWAY_UPDATE_EXECUTOR_CONTRACT } from "../../daemon/service-update-authority.js";
import type * as UpdateRunLedger from "../../infra/update-run-ledger.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import type * as CommandExec from "../../process/exec.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import type * as UpdateCommandExecutor from "./update-command-executor.js";
import { recordServiceTimedStep } from "./update-command-result.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  recordStep: vi.fn(),
}));

vi.mock("../../daemon/gateway-entrypoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GatewayEntrypoint>()),
  resolveGatewayInstallEntrypoint: async () => "/fixture/root/dist/entry.js",
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof CommandExec>()),
  runCommandWithTimeout: mocks.command,
}));
vi.mock("./update-command-executor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateCommandExecutor>()),
  requiresRetainedUpdateCommandOwner: () => false,
  withUpdateCommandExecutorChild: async (
    _executor: unknown,
    _root: string,
    run: (grant: object, bindChild: () => void) => Promise<unknown>,
  ) => await run({ token: "grant" }, () => {}),
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof UpdateRunLedger>()),
  recordUpdateRunStep: mocks.recordStep,
}));

beforeEach(() => {
  vi.useFakeTimers({ now: 1_791_595_070_000 });
  mocks.command.mockReset();
  mocks.recordStep.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

it("times the executor probe separately from the reconciliation install child", async () => {
  mocks.command.mockImplementation(async (argv: string[]) => {
    if (argv.includes("check")) {
      vi.advanceTimersByTime(9_000);
      return createCommandResult({
        code: 0,
        cleanup: "normal",
        stdout: JSON.stringify({
          updateExecutor: GATEWAY_UPDATE_EXECUTOR_CONTRACT,
          targetRootBinding: true,
        }),
      });
    }
    vi.advanceTimersByTime(24_000);
    return createCommandResult({
      code: 0,
      stdout: JSON.stringify({ action: "install", ok: true }),
    });
  });
  const steps: UpdateStepResult[] = [];
  const executorFence: UpdateRecoveryFence = { assertCurrent: () => {} };

  await expect(
    runUpdatedInstallGatewayCommand(
      {
        result: { root: "/fixture/root", mode: "git" },
        opts: { run: { runId: "run-1", env: {}, executorFence } },
        invocationEnv: {},
        nodeRunner: "node",
        gatewayPort: 18809,
        onTimedStep: (step) => steps.push(step),
      },
      "install",
    ),
  ).resolves.toBe("unverified");

  expect(steps).toEqual([
    {
      name: "managed-service-executor-check",
      command: "openclaw gateway install --update-executor check --json",
      cwd: "/fixture/root",
      durationMs: 9_000,
      exitCode: 0,
    },
    {
      name: "managed-service-install",
      command: "openclaw gateway install --force --port 18809 --json",
      cwd: "/fixture/root",
      durationMs: 24_000,
      exitCode: 0,
    },
  ]);
});

it("keeps failed reconciliation children on the existing failure path", async () => {
  mocks.command.mockImplementation(async () => {
    vi.advanceTimersByTime(5_000);
    return createCommandResult({ code: 1, stderr: "install refused" });
  });
  const onTimedStep = vi.fn();

  await expect(
    runUpdatedInstallGatewayCommand(
      { result: { root: "/fixture/root", mode: "npm" }, opts: {}, invocationEnv: {}, onTimedStep },
      "install",
    ),
  ).rejects.toThrow("install refused");
  expect(onTimedStep).not.toHaveBeenCalled();
});

it("records a timed service step in the result and as a measured run row", () => {
  const result: UpdateRunResult = { status: "ok", mode: "git", steps: [], durationMs: 0 };
  const step = {
    name: "managed-service-install",
    command: "openclaw gateway install --force --json",
    cwd: "/fixture/root",
    durationMs: 24_000,
    exitCode: 0,
  };

  recordServiceTimedStep(result, step, { runId: "run-1", env: {} });

  expect(result.steps).toEqual([step]);
  expect(mocks.recordStep).toHaveBeenCalledExactlyOnceWith(
    "run-1",
    expect.objectContaining({
      step: "managed-service-install",
      status: "completed",
      startedAtMs: Date.now() - 24_000,
      endedAtMs: Date.now(),
    }),
    { env: {} },
  );
});

it("keeps the timed step when run history cannot be written", () => {
  mocks.recordStep.mockImplementation(() => {
    throw new Error("database is locked");
  });
  const result: UpdateRunResult = { status: "ok", mode: "git", steps: [], durationMs: 0 };
  const step = {
    name: "managed-service-restart",
    command: "openclaw gateway restart --preserve-definition --json",
    cwd: "/fixture/root",
    durationMs: 3_000,
    exitCode: 0,
  };

  expect(() => recordServiceTimedStep(result, step, { runId: "run-1", env: {} })).not.toThrow();
  expect(result.steps).toEqual([step]);
});
