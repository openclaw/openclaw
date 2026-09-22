import { format } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";

const fixture = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  budget: vi.fn(),
  finish: vi.fn(),
  terminal: vi.fn(),
  writeFile: vi.fn(),
}));

// Exercise the executable's output boundary without update, service, or database effects.
vi.mock("node:fs/promises", () => ({ default: { writeFile: fixture.writeFile } }));
vi.mock("../cli/daemon-cli.js", () => ({ finishUpdateRun: vi.fn() }));
vi.mock("../cli/runtime-cleanup-scope.js", () => ({
  retainCliProcessJobUntilExit: vi.fn(),
  withCliProcessScope: async (run: () => Promise<void>) => run(),
}));
vi.mock("../cli/update-cli/update-command-executor.js", () => ({
  withDelegatedUpdateCommandExecutor: async (
    _executor: unknown,
    _runId: string,
    _root: string,
    run: (fence: { assertCurrent: () => void }) => Promise<unknown>,
  ) => run({ assertCurrent: vi.fn() }),
  withUpdateCommandExecutor: vi.fn(),
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
}));
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
  recordUpdateRunStep: vi.fn(),
}));

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
    const settled = createDeferredCore();
    fixture.close.mockImplementation(async () => {
      await Promise.resolve();
      log.debug("cleanup diagnostic");
      settled.resolve();
    });
    process.argv = [process.execPath, "update-migrated-finalize.worker.js"];
    if (mode === "check") {
      process.argv.push("--check");
    }
    vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () {
      yield JSON.stringify({
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
      });
      return undefined;
    });

    await import("./update-migrated-finalize.worker.js");
    await settled.promise;

    expect(process.exitCode).toBe(originalExitCode);
    if (mode === "human") {
      expect(stdout.join("")).toContain("Update complete\n");
      expect(stdout.join("")).toContain("terminal snapshot diagnostic");
      expect(stderr).toEqual([]);
    } else {
      expect(JSON.parse(stdout.join(""))).toMatchObject(
        mode === "json" ? result : { executorDelegation: "pid-start-v1" },
      );
      expect(stderr.join("")).toContain("cleanup diagnostic");
      if (mode === "json") {
        expect(stderr.join("")).toContain("activation budget diagnostic");
        expect(stderr.join("")).toContain("terminal snapshot diagnostic");
      }
    }
  },
);
