import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import { writeUpdateRecoveryBackupOutcome } from "../../infra/update-recovery-backup.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { printResult } from "./progress.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import {
  continueMigratedUpdateInFreshProcess,
  type MigratedUpdateFinalizationInput,
} from "./update-command-migrated.js";
import { recordUpdateResultNextAction } from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

const state = vi.hoisted(() => ({
  childActive: false,
  executorCurrent: true,
  events: [] as string[],
}));
vi.mock("../../process/exec.js", () => ({ runUtf8CommandWithTimeout: vi.fn() }));
vi.mock("./update-command-executor.js", () => ({
  withUpdateCommandExecutorChild: async (
    _fence: UpdateRecoveryFence,
    _root: string,
    operation: () => Promise<unknown>,
  ) => {
    state.childActive = true;
    try {
      return await operation();
    } finally {
      state.childActive = false;
    }
  },
}));
vi.mock("./update-command-rollback.js", () => ({ rollbackFailedUpdate: vi.fn() }));
vi.mock("../../infra/update-recovery-backup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-recovery-backup.js")>()),
  writeUpdateRecoveryBackupOutcome: vi.fn(),
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  createWindowsTaskAutoStartGuard: vi.fn(() => async () => {}),
}));
vi.mock("../../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks.js")>()),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn(),
  suspendScheduledTaskAutoStartForUpdate: vi.fn(),
}));
vi.mock("../../infra/update-run-ledger.js", () => ({
  recordUpdateRunStep: vi.fn(() => state.events.push("step")),
}));
vi.mock("./update-command-run.js", () => ({
  completeUpdateCommandRun: vi.fn((result: FinishUpdateParams["result"]) => {
    state.events.push("terminal");
    return result;
  }),
}));
vi.mock("./progress.js", () => ({ printResult: vi.fn() }));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  recordUpdateResultNextAction: vi.fn(() => {
    state.events.push("next action");
    return "openclaw gateway status";
  }),
  writeControlPlaneUpdateRestartSentinelBestEffort: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
  state.childActive = false;
  state.executorCurrent = true;
  state.events.length = 0;
  vi.mocked(writeUpdateRecoveryBackupOutcome).mockReset().mockResolvedValue(undefined);
});

function fixture(): FinishUpdateParams {
  const root = dirs.make("migrated-recovery-");
  return {
    mutationStarted: true,
    result: { status: "ok", mode: "npm", root, runId: "recovery-run", steps: [], durationMs: 0 },
    root,
    installKindChanged: false,
    configSnapshot: {
      path: path.join(root, "openclaw.json"),
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
    requestedChannel: null,
    storedChannel: "stable",
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: {
      json: true,
      run: {
        runId: "recovery-run",
        env: { OPENCLAW_STATE_DIR: root },
        executorFence: {
          assertCurrent() {
            if (state.childActive || !state.executorCurrent) {
              throw new Error("Executor is not current");
            }
          },
        },
      },
    },
    packageTransaction: {
      backupRoot: path.join(root, "package-backup"),
      rollback: vi.fn(),
      complete: vi.fn(async () => undefined),
    },
    updateRecoveryBackup: {
      directory: path.join(root, "update-recovery"),
      manifestPath: path.join(root, "update-recovery", "manifest.json"),
      manifestSha256: "a".repeat(64),
    },
    controlPlaneUpdateSentinelMeta: null,
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    packageUpdateNodeRunner: process.execPath,
    updateStepTimeoutMs: 1_000,
    rollbackBlockedReason: "state-migrated-no-rollback",
  };
}

function worker(
  outcome:
    | "failed"
    | "crashed"
    | "transport failed"
    | "uncertain"
    | "unsettled descendants"
    | "lost executor"
    | "success",
  parentRecoverySupported = true,
  afterChild?: () => void,
) {
  vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (argv, options) => {
    const command = {
      stdout: "",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit" as const,
      cleanup: "normal" as const,
    };
    if (argv.at(-1) === "--check") {
      return {
        ...command,
        stdout: JSON.stringify({
          executorDelegation: "pid-start-v1",
          ...(parentRecoverySupported ? { updateRecovery: "parent-v1" } : {}),
        }),
      };
    }
    expect(rollbackFailedUpdate).not.toHaveBeenCalled();
    assert(typeof options === "object");
    const input = JSON.parse(String(options.input)) as MigratedUpdateFinalizationInput; // SAFETY: The real typed parent serializes this private worker input.
    if (!parentRecoverySupported) {
      expect(input.params).not.toHaveProperty("updateRecoveryBackup");
      expect(input.params).not.toHaveProperty("candidateUpdateRecovery");
      expect(input.params).not.toHaveProperty("deferFailureRecoveryToParent");
    }
    if (outcome === "crashed") {
      return { ...command, code: 1 };
    }
    if (outcome === "transport failed") {
      throw Object.assign(new Error("Candidate output failed after cleanup"), {
        cleanup: "forced",
      });
    }
    await fs.writeFile(
      input.resultPath,
      JSON.stringify({
        result: {
          ...input.params.result,
          status: outcome === "success" ? "ok" : "error",
          reason:
            outcome === "success"
              ? undefined
              : outcome === "unsettled descendants"
                ? "update-processes-unsettled"
                : "restart-unhealthy",
        },
        exitCode: outcome === "success" ? 0 : 1,
        executorDelegation: "pid-start-v1",
        ...(outcome === "success" || !parentRecoverySupported
          ? { terminalRunId: "recovery-run" }
          : { recoveryRequired: true }),
      }),
    );
    state.events.push("child finished");
    afterChild?.();
    if (outcome === "lost executor") {
      state.executorCurrent = false;
    }
    return outcome === "uncertain" ? { ...command, cleanup: "uncertain" } : command;
  });
}

it.each(["failed"] as const)(
  "restores the retained package and state after the candidate %s and exits",
  async (outcome) => {
    const params = fixture();
    worker(outcome);
    vi.mocked(rollbackFailedUpdate).mockImplementation(async (input) => {
      expect(state.childActive).toBe(false);
      input.opts.run?.executorFence?.assertCurrent();
      expect(input.packageTransaction).toBe(params.packageTransaction);
      expect(input.updateRecoveryBackup).toBe(params.updateRecoveryBackup);
      state.events.push("restored");
      return {
        result: {
          ...input.result,
          recovery: { serviceRestartSafe: true, version: "2026.9.3", service: "healthy" },
        },
        rolledBack: true,
        stateRestored: true,
      };
    });
    await expect(continueMigratedUpdateInFreshProcess(params, [])).resolves.toMatchObject({
      result: { status: "error", recovery: { service: "healthy" } },
      exitCode: 1,
    });
    expect(rollbackFailedUpdate).toHaveBeenCalledOnce();
    expect(state.events.indexOf("restored")).toBeLessThan(state.events.indexOf("terminal"));
    expect(printResult).toHaveBeenCalledOnce();
  },
);

it.each(["crashed", "transport failed"] as const)(
  "retains recovery without a worker settlement receipt after %s",
  async (outcome) => {
    worker(outcome);
    vi.mocked(rollbackFailedUpdate).mockImplementation(async ({ result }) => ({
      result,
      rolledBack: true,
      stateRestored: true,
    }));
    await expect(continueMigratedUpdateInFreshProcess(fixture(), [])).rejects.toThrow(
      "npx openclaw@latest doctor --fix",
    );
    expect(rollbackFailedUpdate).not.toHaveBeenCalled();
    expect(recordUpdateResultNextAction).not.toHaveBeenCalled();
    expect(printResult).not.toHaveBeenCalled();
  },
);

it.each(["uncertain", "lost executor"] as const)(
  "does not restore state after %s candidate ownership",
  async (outcome) => {
    worker(outcome);
    await expect(continueMigratedUpdateInFreshProcess(fixture(), [])).rejects.toThrow();
    expect(rollbackFailedUpdate).not.toHaveBeenCalled();
    expect(recordUpdateResultNextAction).not.toHaveBeenCalled();
    expect(printResult).not.toHaveBeenCalled();
  },
);

it("retains recovery when the worker reports unsettled descendants despite normal launcher cleanup", async () => {
  const params = fixture();
  worker("unsettled descendants");
  vi.mocked(rollbackFailedUpdate).mockImplementation(async ({ result }) => ({
    result,
    rolledBack: true,
    stateRestored: true,
  }));
  await expect(continueMigratedUpdateInFreshProcess(params, [])).rejects.toThrow(
    "npx openclaw@latest doctor --fix",
  );
  expect(rollbackFailedUpdate).not.toHaveBeenCalled();
  expect(recordUpdateResultNextAction).not.toHaveBeenCalled();
  expect(printResult).not.toHaveBeenCalled();
});

it.each(["run", "executor"] as const)(
  "refuses parent restoration after its original %s is replaced",
  async (replacement) => {
    const params = fixture();
    const originalRun = params.opts.run;
    assert(originalRun);
    worker("failed", true, () => {
      if (replacement === "run") {
        params.opts.run = { ...originalRun };
      } else {
        originalRun.executorFence = { assertCurrent: vi.fn() };
      }
    });
    vi.mocked(rollbackFailedUpdate).mockImplementation(async (input) => ({
      result: input.result,
      rolledBack: true,
      stateRestored: true,
    }));
    await expect(continueMigratedUpdateInFreshProcess(params, [])).rejects.toThrow(
      "lost its original executor",
    );
    expect(rollbackFailedUpdate).not.toHaveBeenCalled();
    expect(recordUpdateResultNextAction).not.toHaveBeenCalled();
    expect(printResult).not.toHaveBeenCalled();
  },
);

it("does not reopen the old ledger when state restoration fails", async () => {
  worker("failed");
  vi.mocked(rollbackFailedUpdate).mockImplementation(async (input) => ({
    result: input.result,
    rolledBack: false,
    pendingRecoveryReason:
      "Backup payload failed verification; run npx openclaw@latest doctor --fix",
  }));
  await expect(continueMigratedUpdateInFreshProcess(fixture(), [])).rejects.toThrow(
    "Backup payload failed verification",
  );
  expect(rollbackFailedUpdate).toHaveBeenCalledOnce();
  expect(recordUpdateResultNextAction).not.toHaveBeenCalled();
  expect(printResult).not.toHaveBeenCalled();
});

it("keeps successful candidate finalization terminal and fences package completion", async () => {
  const params = fixture();
  const complete = params.packageTransaction?.complete;
  assert(complete);
  let completionFence: (() => void) | undefined;
  vi.mocked(complete).mockImplementation(async (_outcome, assertCurrent) => {
    completionFence = assertCurrent;
    expect(state.childActive).toBe(false);
    assertCurrent();
  });
  worker("success");
  await expect(continueMigratedUpdateInFreshProcess(params, [])).resolves.toMatchObject({
    result: { status: "ok" },
    exitCode: 0,
  });
  expect(rollbackFailedUpdate).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledWith({ activationVerified: true }, expect.any(Function));
  assert(completionFence);
  state.executorCurrent = false;
  expect(completionFence).toThrow("Executor is not current");
});

it.each(["success", "failed"] as const)(
  "supports older finalizer capability without early capture settlement (outcome=%s)",
  async (outcome) => {
    const params = fixture();
    params.candidateUpdateRecovery = "parent-v1";
    const backup = params.updateRecoveryBackup;
    assert(backup);
    await fs.mkdir(backup.directory);
    const recoveryBytes = "retained recovery fixture\n";
    await fs.writeFile(backup.manifestPath, recoveryBytes);
    worker(outcome, false);
    vi.mocked(rollbackFailedUpdate).mockImplementation(async (input) => ({
      result: {
        ...input.result,
        recovery: { serviceRestartSafe: true, version: "2026.9.3", service: "healthy" },
      },
      rolledBack: true,
      stateRestored: true,
    }));
    const completed = await continueMigratedUpdateInFreshProcess(params, []);
    expect(writeUpdateRecoveryBackupOutcome).not.toHaveBeenCalled();
    if (outcome === "failed") {
      expect(completed).toMatchObject({
        exitCode: 1,
        result: { reason: "restart-unhealthy", recovery: { service: "healthy" } },
      });
      expect(rollbackFailedUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          packageTransaction: params.packageTransaction,
          updateRecoveryBackup: params.updateRecoveryBackup,
        }),
      );
    } else {
      expect(completed).toMatchObject({ exitCode: 0, result: { status: "ok" } });
      expect(rollbackFailedUpdate).not.toHaveBeenCalled();
      expect(await fs.readFile(backup.manifestPath, "utf8")).toBe(recoveryBytes);
      const warning = completed.result.steps.find(
        (step) => step.name === "backup completion warning",
      );
      expect(warning?.exitCode).toBe(0);
      expect(warning?.stderrTail).toContain(backup.manifestPath);
      expect(warning?.stderrTail).toContain("openclaw update status --json");
      expect(warning?.stderrTail).toContain("npx openclaw@latest doctor --fix");
    }
  },
);

it.each([true, false])(
  "settles Windows task ownership without reopening migrated state (restored=%s)",
  async (restored) => {
    const params = fixture();
    const actions: string[] = [];
    vi.mocked(resumeScheduledTaskAutoStartAfterUpdate).mockImplementation(async (_env, options) => {
      await options?.beforeMutation?.();
      actions.push("enable");
      return true;
    });
    vi.mocked(suspendScheduledTaskAutoStartForUpdate).mockImplementation(async (_env, options) => {
      await options?.beforeMutation?.();
      actions.push("disable");
      return true;
    });
    const original = createWindowsTaskAutoStartRecovery({
      serviceEnv: {},
      alreadySuspended: true,
      assertCurrent: () => {
        if (state.events.includes("child finished")) {
          throw new Error("Previous runtime cannot inspect migrated state");
        }
      },
    });
    params.preManagedServiceStop = {
      stopped: true,
      inspected: true,
      runtimeInspected: true,
      running: true,
      serviceEnv: {},
      windowsTaskAutoStartRecovery: original,
    };
    worker("failed");
    vi.mocked(rollbackFailedUpdate).mockImplementation(async (input) => {
      const recovery = input.preManagedServiceStop?.windowsTaskAutoStartRecovery;
      expect(recovery).toBeDefined();
      expect(recovery).not.toBe(original);
      if (!restored) {
        return { result: input.result, rolledBack: false, pendingRecoveryReason: "Backup corrupt" };
      }
      await recovery?.restore(true);
      return {
        result: {
          ...input.result,
          recovery: { serviceRestartSafe: true, version: "2026.9.3", service: "healthy" },
        },
        rolledBack: true,
        stateRestored: true,
      };
    });
    try {
      const operation = continueMigratedUpdateInFreshProcess(params, []);
      if (restored) {
        await expect(operation).resolves.toMatchObject({
          result: { recovery: { service: "healthy" } },
        });
      } else {
        await expect(operation).rejects.toThrow("Backup corrupt");
      }
      expect(actions).toEqual(restored ? ["enable"] : []);
    } finally {
      await original.complete(true);
    }
  },
);
