import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { parseCmdScriptCommandLine } from "../../daemon/cmd-argv.js";
import {
  readWindowsTaskSupervisorRestartExitCode as readRestartExitCode,
  WINDOWS_TASK_SUPERVISOR_CHILD_FLAG,
} from "../../daemon/windows-task-supervisor-contract.js";
import type { SpawnInput } from "../../process/supervisor/types.js";
import { captureEnv } from "../../test-utils/env.js";
import { runWindowsGatewayTaskSupervisor as runSupervisor } from "./task-supervisor.js";

const { spawn, log, flushLogger, bindWindowsTaskLauncher } = vi.hoisted(() => ({
  spawn: vi.fn(),
  log: { info: vi.fn(), error: vi.fn() },
  flushLogger: vi.fn(async () => {}),
  bindWindowsTaskLauncher: vi.fn(),
}));

vi.mock("../../process/supervisor/service-child-windows-task-launcher.js", () => ({
  bindWindowsTaskLauncher,
}));

// mock-isolation: Capture supervisor diagnostics without initializing real log transports.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
vi.mock("../../logging/logger.js", () => ({ flushLogger }));
// mock-isolation: Keep supervisor tests from launching real child processes.
vi.mock("../../process/supervisor/index.js", () => ({ getProcessSupervisor: () => ({ spawn }) }));

function readSpawnRestartExitCode(input: SpawnInput): number {
  if (input.mode !== "anchored-shell") {
    throw new Error("Expected anchored shell input");
  }
  const exitCode = readRestartExitCode(parseCmdScriptCommandLine(input.command));
  if (exitCode === undefined) {
    throw new Error("Expected a correlated task-supervisor restart code");
  }
  return exitCode;
}

type ChildResult = { exitCode: number | null; exitSignal: string | null; reason?: string };
function childRun(
  result: ChildResult = { exitCode: 0, exitSignal: null },
  waitForExtinction: () => Promise<unknown> = vi.fn(async () => {}),
) {
  return { cancel: vi.fn(), wait: async () => result, waitForExtinction };
}

function expectDiagnostic(logger: typeof log.info, fields: Record<string, unknown>) {
  expect(logger).toHaveBeenCalledWith(expect.any(String), expect.objectContaining(fields));
}

function captureShutdown() {
  let shutdown: (() => void) | undefined;
  vi.spyOn(process, "once").mockImplementation(((event: string, listener: () => void) => {
    if (event === "SIGTERM") {
      shutdown = listener;
    }
    return process;
  }) as typeof process.once);
  return () => shutdown?.();
}

describe("Windows Gateway task supervisor", () => {
  const argv = [...process.argv];
  const execArgv = [...process.execArgv];
  const exitCode = process.exitCode;
  const originalEnv = captureEnv(["OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER"]);

  beforeEach(() => {
    process.argv = [process.execPath, "C:\\oc\\entry.js", "gateway", "--task-supervisor"];
    process.execArgv = ["--import", "tsx"];
    process.exitCode = undefined;
    delete process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(() => {
    process.argv = [...argv];
    process.execArgv = [...execArgv];
    process.exitCode = exitCode;
    originalEnv.restore();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    spawn.mockReset();
    bindWindowsTaskLauncher.mockReset();
  });

  it.each([
    { launcher: "wscript", live: true },
    { launcher: "cmd", live: true },
    { launcher: "wscript", live: false },
    { launcher: "cmd", live: false },
  ])("requires live $launcher ownership ($live)", async ({ launcher, live }) => {
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = launcher;
    bindWindowsTaskLauncher.mockImplementation(() => {
      expect(spawn).not.toHaveBeenCalled();
      expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
      if (!live) {
        throw new Error(`Windows task ${launcher} launcher is no longer live`);
      }
    });
    spawn.mockImplementation(async () => {
      expect(bindWindowsTaskLauncher).toHaveBeenCalledOnce();
      expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
      return { cancel: vi.fn(), wait: async () => ({ exitCode: 0, exitSignal: null }) };
    });
    await runSupervisor();
    expect(bindWindowsTaskLauncher).toHaveBeenCalledExactlyOnceWith(launcher);
    expect(process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER).toBeUndefined();
    if (live) {
      expect(spawn).toHaveBeenCalledOnce();
    } else {
      expect(spawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(JSON.stringify(log.error.mock.calls)).toContain(
        `${launcher} launcher is no longer live`,
      );
    }
  });

  it("runs the Gateway child through the anchored Job Object and waits for its tree", async () => {
    process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER = "1";
    const waitForExtinction = vi.fn(async () => {});
    spawn.mockResolvedValue(childRun(undefined, waitForExtinction));
    await runSupervisor();

    expect(bindWindowsTaskLauncher).not.toHaveBeenCalled();
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      mode: "anchored-shell",
      command: expect.stringContaining("gateway"),
      scopeKey: `gateway-task-supervisor:${process.pid}`,
      captureOutput: false,
    });
    expect(spawn.mock.calls[0]?.[0].command).not.toMatch(/"--task-supervisor"(?:\s|$)/u);
    expect(spawn.mock.calls[0]?.[0].command).toContain(`${WINDOWS_TASK_SUPERVISOR_CHILD_FLAG}=`);
    expect(spawn.mock.calls[0]?.[0].command).toContain("--import");
    expect(spawn.mock.calls[0]?.[0].command).toContain("tsx");
    readSpawnRestartExitCode(spawn.mock.calls[0]?.[0]);
    expect(waitForExtinction).toHaveBeenCalledOnce();
  });

  it.each([
    { exitCode: 75, exitSignal: null, reason: "exit", expectedCode: 75 },
    { exitCode: null, exitSignal: "SIGTERM", reason: "signal", expectedCode: 1 },
    { exitCode: 0, exitSignal: null, reason: "exit", expectedCode: 0 },
  ])("preserves child result $exitCode/$exitSignal", async ({ expectedCode, ...result }) => {
    const stderr = "Gateway failed to bind its configured port\n";
    spawn.mockImplementation(async (input: SpawnInput) => {
      input.onStderr?.(stderr);
      return childRun(result, async () => {
        expect(process.exitCode).toBeUndefined();
      });
    });
    flushLogger.mockImplementationOnce(async () => {
      expect(process.exitCode).toBeUndefined();
    });

    await runSupervisor();

    expect(spawn).toHaveBeenCalledOnce();
    expect(process.exitCode ?? 0).toBe(expectedCode);
    expectDiagnostic(result.exitCode === 0 ? log.info : log.error, { ...result, stderr });
    expect(flushLogger).toHaveBeenCalledOnce();
  });

  it("retains only a bounded stderr tail and discards stdout", async () => {
    const lastReason = "final startup failure";
    spawn.mockImplementation(async (input: SpawnInput) => {
      expect(input.captureOutput).toBe(false);
      input.onStdout?.("unretained stdout");
      input.onStderr?.("old stderr diagnostic\n");
      input.onStderr?.("x".repeat(8192));
      input.onStderr?.(lastReason);
      return childRun({ exitCode: 1, exitSignal: null, reason: "exit" });
    });

    await runSupervisor();

    expectDiagnostic(log.error, { stderr: expect.stringContaining(lastReason) });
    const stderr: string = log.error.mock.calls[0]?.[1].stderr;
    expect(stderr.length).toBeLessThanOrEqual(8192);
    expect(stderr).not.toContain("old stderr diagnostic");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("unretained stdout");
  });

  it("preserves the child diagnostic when its tree cleanup fails", async () => {
    const stderr = "synthetic child startup failure";
    spawn.mockImplementation(async (input: SpawnInput) => {
      input.onStderr?.(stderr);
      return childRun({ exitCode: 23, exitSignal: null, reason: "exit" }, async () => {
        expectDiagnostic(log.error, { exitCode: 23, stderr });
        throw new Error("synthetic Job Object cleanup failure");
      });
    });

    await runSupervisor();

    expect(process.exitCode).toBe(1);
    expect(JSON.stringify(log.error.mock.calls)).toContain("synthetic Job Object cleanup failure");
    expect(flushLogger).toHaveBeenCalledOnce();
  });

  it("replaces only a child that requests an ordinary Gateway restart", async () => {
    const firstExtinction = vi.fn(async () => {});
    const secondExtinction = vi.fn(async () => {});
    spawn
      .mockImplementationOnce(async (input: SpawnInput) =>
        childRun({ exitCode: readSpawnRestartExitCode(input), exitSignal: null }, firstExtinction),
      )
      .mockResolvedValueOnce(childRun(undefined, secondExtinction));
    await runSupervisor();

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(firstExtinction).toHaveBeenCalledOnce();
    expect(secondExtinction).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["wait", "extinction"])(
    "suppresses restart when shutdown arrives during %s",
    async (phase) => {
      const shutdown = captureShutdown();
      spawn.mockImplementationOnce(async (input: SpawnInput) => ({
        ...childRun(undefined, async () => {
          if (phase === "extinction") {
            shutdown();
          }
        }),
        wait: async () => {
          if (phase === "wait") {
            shutdown();
          }
          return { exitCode: readSpawnRestartExitCode(input), exitSignal: null };
        },
      }));
      await runSupervisor();

      expect(spawn).toHaveBeenCalledOnce();
      expect(process.exitCode).toBeUndefined();
      expect(log.error).not.toHaveBeenCalled();
    },
  );

  it("cancels a child when shutdown arrives while spawn is pending", async () => {
    const pendingSpawn = createDeferred<ReturnType<typeof childRun>>();
    const cancel = vi.fn();
    const shutdown = captureShutdown();
    spawn.mockReturnValue(pendingSpawn.promise);
    const running = runSupervisor();
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    shutdown();
    pendingSpawn.resolve({ ...childRun(), cancel });
    await running;

    expect(cancel).toHaveBeenCalledOnce();
  });
});
