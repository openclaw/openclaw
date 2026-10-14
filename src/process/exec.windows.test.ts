// Windows exec tests cover trusted command wrapping, tree termination, and output decoding.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";

const execaMock = vi.fn();
const isRegularFileMock = vi.fn();
const resolveExecutableFromPathEnvMock = vi.fn();
const resolveExecutablePathCandidateMock = vi.fn();
const spawnSyncMock = vi.fn();

type MockResult = {
  cause?: unknown;
  code?: string;
  exitCode?: number;
  failed: boolean;
  isCanceled?: boolean;
  isMaxBuffer?: boolean;
  isTerminated: boolean;
  signal?: NodeJS.Signals;
  stderr?: Buffer;
  stdout?: Buffer;
  timedOut?: boolean;
};

type MockSubprocess = EventEmitter & {
  nodeChildProcess: MockSubprocess;
  exitCode: number | null;
  finish: (result?: Partial<MockResult>) => void;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  pid: number;
  signalCode: NodeJS.Signals | null;
  stderr: PassThrough;
  stdout: PassThrough;
  catch: Promise<MockResult>["catch"];
  finally: Promise<MockResult>["finally"];
  then: Promise<MockResult>["then"];
};

type ExecaCall = [string, string[], Record<string, unknown>];

function createMockSubprocess(params?: {
  autoFinish?: boolean;
  exitCode?: number;
  reject?: boolean;
  signal?: NodeJS.Signals;
  stderr?: Buffer;
  stderrChunks?: Buffer[];
  stdout?: Buffer;
  stdoutChunks?: Buffer[];
}): MockSubprocess {
  const child = new EventEmitter() as MockSubprocess;
  child.nodeChildProcess = child;
  child.pid = 1234;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  let resolve!: (result: MockResult) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<MockResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // oxlint-disable-next-line unicorn/no-thenable -- Stub combines Execa's promise with its exposed Node child.
  child.then = completion.then.bind(completion);
  child.catch = completion.catch.bind(completion);
  child.finally = completion.finally.bind(completion);
  child.finish = (overrides = {}) => {
    for (const chunk of params?.stdoutChunks ?? []) {
      child.stdout.write(chunk);
    }
    for (const chunk of params?.stderrChunks ?? []) {
      child.stderr.write(chunk);
    }
    const exitCode = Object.hasOwn(overrides, "exitCode")
      ? overrides.exitCode
      : (params?.exitCode ?? 0);
    const signal = overrides.signal ?? params?.signal;
    child.exitCode = signal ? null : (exitCode ?? null);
    child.signalCode = signal ?? null;
    child.emit("exit", child.exitCode, child.signalCode);
    const result = {
      exitCode: signal ? undefined : exitCode,
      failed: signal !== undefined || exitCode !== 0,
      isTerminated: signal !== undefined,
      signal,
      stderr: params?.stderr ?? Buffer.concat(params?.stderrChunks ?? []),
      stdout: params?.stdout ?? Buffer.concat(params?.stdoutChunks ?? []),
      ...overrides,
    };
    if (params?.reject) {
      reject(Object.assign(new Error("command failed"), result));
    } else {
      resolve(result);
    }
  };
  if (params?.autoFinish !== false) {
    queueMicrotask(() => child.finish());
  }
  return child;
}

function pendingCommand() {
  vi.useFakeTimers();
  const command = createMockSubprocess({ autoFinish: false });
  execaMock.mockReturnValueOnce(command);
  return command;
}

function requireExecaCall(index: number): ExecaCall {
  const call = execaMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected execa call ${index}`);
  }
  return call as ExecaCall;
}

function expectedTrustedCmdExe(): string {
  return path.win32.join(getWindowsInstallRoots().systemRoot, "System32", "cmd.exe");
}

function expectCmdWrappedInvocation(call: ExecaCall, commandFragment = "pnpm.cmd") {
  expect(call[0]).toBe(expectedTrustedCmdExe());
  expect(call[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(call[1][3]).toContain(commandFragment);
  expect(call[1][3]).toContain("--version");
  expect(call[2]).toMatchObject({
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: true,
  });
}

let runCommandWithTimeout: typeof import("./exec.js").runCommandWithTimeout;
let runCommandBuffered: typeof import("./exec.js").runCommandBuffered;
let runCommandBuffersWithTimeout: typeof import("./exec-runner.js").runCommandBuffersWithTimeout;
let runExec: typeof import("./exec.js").runExec;
let spawnCommand: typeof import("./exec.js").spawnCommand;
let withCommandProcessScope: typeof import("./exec-spawn.js").withCommandProcessScope;
let getWindowsInstallRoots: typeof import("../infra/windows-install-roots.js").getWindowsInstallRoots;

describe("Windows command execution", () => {
  beforeEach(async () => {
    vi.resetModules();
    const accessSync = fs.accessSync.bind(fs);
    vi.spyOn(fs, "accessSync").mockImplementation((filePath, mode) => {
      if (String(filePath).toLowerCase() === "c:\\windows\\system32\\reg.exe") {
        throw new Error("registry lookup disabled for test");
      }
      return accessSync(filePath, mode);
    });
    vi.doMock("execa", () => ({ execa: execaMock }));
    vi.doMock("../infra/executable-path.js", async () => {
      const actual = await vi.importActual<typeof import("../infra/executable-path.js")>(
        "../infra/executable-path.js",
      );
      return {
        ...actual,
        isRegularFile: isRegularFileMock,
        resolveExecutableFromPathEnv: resolveExecutableFromPathEnvMock,
        resolveExecutablePathCandidate: resolveExecutablePathCandidateMock,
      };
    });
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawnSync: spawnSyncMock };
    });
    ({ getWindowsInstallRoots } = await import("../infra/windows-install-roots.js"));
    ({ runCommandBuffered, runCommandWithTimeout, runExec, spawnCommand } =
      await import("./exec.js"));
    ({ runCommandBuffersWithTimeout } = await import("./exec-runner.js"));
    ({ withCommandProcessScope } = await import("./exec-spawn.js"));
  });

  afterAll(() => {
    vi.doUnmock("execa");
    vi.doUnmock("../infra/executable-path.js");
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  beforeEach(() => {
    execaMock.mockReset();
    execaMock.mockImplementation(() => createMockSubprocess());
    isRegularFileMock.mockReset();
    isRegularFileMock.mockReturnValue(true);
    resolveExecutableFromPathEnvMock.mockReset();
    resolveExecutableFromPathEnvMock.mockImplementation((command: string) => {
      const basename = path.win32.basename(command).toLowerCase();
      if (["corepack", "pnpm", "yarn"].includes(basename)) {
        return undefined;
      }
      if (command.includes("\\")) {
        return command;
      }
      const extension = path.extname(command) || path.win32.extname(command);
      return path.win32.join(
        "C:\\openclaw-test-bin",
        extension ? command : `${path.win32.basename(command)}.exe`,
      );
    });
    resolveExecutablePathCandidateMock.mockReset();
    resolveExecutablePathCandidateMock.mockImplementation((command: string) => command);
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ stdout: "Active code page: 936", stderr: "" });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("ignores ComSpec when selecting the Windows command wrapper", async () => {
    vi.stubEnv("ComSpec", "C:\\workspace\\evil\\cmd.exe");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    await withMockedWindowsPlatform(async () => {
      await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1_000 });
      expectCmdWrappedInvocation(requireExecaCall(0));
      expect(requireExecaCall(0)[0].toLowerCase()).toBe("c:\\windows\\system32\\cmd.exe");
    });
  });

  it("rejects unresolved commands before Execa can consult ambient ComSpec", async () => {
    resolveExecutableFromPathEnvMock.mockReturnValueOnce(undefined);

    await withMockedWindowsPlatform(async () => {
      expect(() =>
        spawnCommand(["missing\r\ncalc.exe"], {
          baseEnv: {
            ComSpec: "C:\\workspace\\evil\\cmd.exe",
            PATH: "C:\\openclaw-test-bin",
            PATHEXT: ".EXE;.CMD;.BAT;.COM",
          },
        }),
      ).toThrow("ENOENT");
      expect(execaMock).not.toHaveBeenCalled();
    });
  });

  it("rejects unsupported Windows command types before Execa", async () => {
    resolveExecutableFromPathEnvMock.mockReturnValueOnce("C:\\tools\\script.ps1");

    await withMockedWindowsPlatform(async () => {
      expect(() => spawnCommand(["script.ps1"])).toThrow("Unsupported Windows command extension");
      expect(execaMock).not.toHaveBeenCalled();
    });
  });

  it("spawns node plus npm-cli.js instead of npm.cmd when available", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(process, "execPath", "get").mockReturnValue("C:\\Program Files\\nodejs\\node.exe");
    await withMockedWindowsPlatform(async () => {
      void spawnCommand(["npm", "--version"]);
      const [command, args, options] = requireExecaCall(0);
      expect(path.win32.basename(command).toLowerCase()).toBe("node.exe");
      expect(args[0]).toContain(path.join("node_modules", "npm", "bin", "npm-cli.js"));
      expect(args[1]).toBe("--version");
      expect(options).toMatchObject({ shell: false, windowsHide: true });
    });
  });

  it("falls back to a trusted npm.cmd wrapper when npm-cli.js is unavailable", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    await withMockedWindowsPlatform(async () => {
      void spawnCommand(["npm", "--version"]);
      expectCmdWrappedInvocation(requireExecaCall(0), "npm.cmd");
    });
  });

  it("infers success when a spawned Windows shim has no exit state", async () => {
    const command = pendingCommand();

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["pnpm", "--version"], {
        timeoutMs: 1_000,
      });
      command.finish({ exitCode: undefined, failed: true });
      await expect(resultPromise).resolves.toMatchObject({ code: 0, termination: "exit" });
    });
  });

  it("sanitizes a Windows shim launch error without an exit state", async () => {
    const command = createMockSubprocess({ autoFinish: false });
    execaMock.mockReturnValueOnce(command);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["pnpm", "--version"], {
        timeoutMs: 1_000,
      });
      command.finish({
        cause: new Error("spawn pnpm ENOENT"),
        code: "ENOENT",
        exitCode: undefined,
        failed: true,
      });

      await expect(resultPromise).rejects.toMatchObject({
        code: "ENOENT",
        message: "Command failed during launch or output capture (ENOENT)",
      });
    });
  });

  it("does not target an exited Windows root while output settles", async () => {
    const exitCode = 7;
    const command = pendingCommand();

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "quick.js"], {
        timeoutMs: 80,
        killProcessTree: true,
      });
      command.exitCode = exitCode;
      command.emit("exit", exitCode, null);

      await vi.advanceTimersByTimeAsync(81);
      expect(execaMock).toHaveBeenCalledTimes(1);
      expect(command.stdout.destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(19);
      expect(command.stdout.destroyed).toBe(false);
      await vi.advanceTimersToNextTimerAsync();
      expect(command.stdout.destroyed).toBe(true);
      expect(command.stderr.destroyed).toBe(true);

      command.finish({ exitCode });
      await expect(resultPromise).resolves.toMatchObject({ code: exitCode, termination: "exit" });
    });
  });

  it.each(["stdout", "stderr"] as const)(
    "terminates a Windows process tree when its %s stream fails",
    async (stream) => {
      vi.useFakeTimers();
      const command = createMockSubprocess({ autoFinish: false });
      execaMock
        .mockImplementationOnce(() => command)
        .mockImplementation(() => createMockSubprocess());

      await withMockedWindowsPlatform(async () => {
        const resultPromise = runCommandBuffered(["node", "idle.js"], {
          terminateOnOutputError: true,
          timeoutMs: 10_000,
        });
        command[stream].destroy(new Error(`${stream} EPIPE`));

        await vi.advanceTimersByTimeAsync(301);
        command.finish({ signal: "SIGKILL" });

        await expect(resultPromise).resolves.toMatchObject({
          error: { message: `${stream} EPIPE` },
          errorStream: stream,
          termination: "error",
        });
      });
    },
  );

  it("joins graceful and forced taskkill before canceling a scoped Windows root", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    const gracefulTaskkill = createMockSubprocess({
      autoFinish: false,
      exitCode: 1,
    });
    const forcedTaskkill = createMockSubprocess({ autoFinish: false });
    execaMock
      .mockImplementationOnce(() => command)
      .mockImplementationOnce(() => gracefulTaskkill)
      .mockImplementationOnce(() => forcedTaskkill);

    await withMockedWindowsPlatform(async () => {
      const controller = new AbortController();
      const resultPromise = withCommandProcessScope(
        () =>
          runCommandWithTimeout(["node", "idle.js"], {
            killProcessTree: true,
          }),
        controller.signal,
      );
      const cancelSignal = requireExecaCall(0)[2].cancelSignal as AbortSignal;

      controller.abort();
      await vi.advanceTimersByTimeAsync(300);
      expect(requireExecaCall(2)[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      // Graceful taskkill expires while its later-started forced sibling still owns the root.
      await vi.advanceTimersByTimeAsync(5_000 - 300);
      gracefulTaskkill.finish({ signal: "SIGTERM", timedOut: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(command.kill).not.toHaveBeenCalled();
      expect(cancelSignal.aborted).toBe(false);
      for (const index of [1, 2]) {
        const cleanupSignal = requireExecaCall(index)[2].cancelSignal as AbortSignal | undefined;
        expect(cleanupSignal?.aborted).not.toBe(true);
      }

      forcedTaskkill.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelSignal.aborted).toBe(true);

      command.finish({ signal: "SIGKILL" });
      await expect(resultPromise).resolves.toMatchObject({
        termination: "signal",
        cleanup: "forced",
      });
    });
  });

  it("waits for immediate forced taskkill before aborting the Windows root", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    const forcedTaskkill = createMockSubprocess({ autoFinish: false });
    execaMock.mockImplementationOnce(() => command).mockImplementationOnce(() => forcedTaskkill);

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], {
        killProcessTree: false,
        timeoutMs: 80,
      });
      const cancelSignal = requireExecaCall(0)[2].cancelSignal as AbortSignal;

      await vi.advanceTimersByTimeAsync(81);
      expect(requireExecaCall(1)[1]).toEqual(["/PID", "1234", "/T", "/F"]);
      expect(cancelSignal.aborted).toBe(false);

      forcedTaskkill.finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(cancelSignal.aborted).toBe(true);

      command.finish({ signal: "SIGKILL" });
      await expect(resultPromise).resolves.toMatchObject({ code: 124, termination: "timeout" });
    });
  });

  it("cancels the Windows root when every taskkill fails to spawn", async () => {
    vi.useFakeTimers();
    const command = createMockSubprocess({ autoFinish: false });
    execaMock
      .mockImplementationOnce(() => command)
      .mockImplementation(() => {
        throw new Error("taskkill could not spawn");
      });

    await withMockedWindowsPlatform(async () => {
      const resultPromise = runCommandWithTimeout(["node", "idle.js"], {
        killProcessTree: true,
        timeoutMs: 80,
      });
      const cancelSignal = requireExecaCall(0)[2].cancelSignal as AbortSignal;

      await vi.advanceTimersByTimeAsync(80);
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersByTimeAsync(300);
      expect(cancelSignal.aborted).toBe(true);
      command.finish({ signal: "SIGKILL" });

      await expect(resultPromise).resolves.toMatchObject({ code: 124, termination: "timeout" });
    });
  });

  it("preserves decoded diagnostics on runExec failure", async () => {
    const bytes = Buffer.from([0xb2, 0xe2]);
    execaMock.mockImplementationOnce(() =>
      createMockSubprocess({ exitCode: 1, reject: true, stdout: bytes, stderr: bytes }),
    );
    await withMockedWindowsPlatform(async () => {
      await expect(runExec("node", ["failed-output.js"], 1_000)).rejects.toMatchObject({
        message: "command failed",
        code: 1,
        exitCode: 1,
        stdout: "测",
        stderr: "测",
      });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    });
  });

  it("captures the raw result encoding before the child can change the console page", async () => {
    const stdout = Buffer.from([0xb2, 0xe2]);
    const stderr = Buffer.from([0xa3, 0xbb]);
    execaMock.mockImplementationOnce(() => {
      spawnSyncMock.mockReturnValue({ stdout: "Active code page: 1252", stderr: "" });
      return createMockSubprocess({
        stdoutChunks: [stdout.subarray(0, 1), stdout.subarray(1)],
        stderrChunks: [stderr],
      });
    });
    await withMockedWindowsPlatform(async () => {
      await expect(
        runCommandBuffersWithTimeout(["node", "legacy-output.js"], 1_000),
      ).resolves.toMatchObject({
        code: 0,
        stdout,
        stderr,
        windowsEncoding: "gbk",
      });
    });
  });

  it("decodes truncated, split output with the code page captured before spawn", async () => {
    execaMock.mockImplementationOnce(() => {
      spawnSyncMock.mockReturnValue({ stdout: "Active code page: 1252", stderr: "" });
      return createMockSubprocess({
        stdoutChunks: [Buffer.from([0x61, 0xb2]), Buffer.from([0xe2, 0xca, 0xd4])],
      });
    });
    await withMockedWindowsPlatform(async () => {
      await expect(
        runCommandWithTimeout(["node", "gbk-output.js"], {
          maxOutputBytes: 3,
          outputCapture: "head",
          timeoutMs: 1_000,
        }),
      ).resolves.toMatchObject({
        stdout: "a测",
        stdoutTruncatedBytes: 2,
      });
    });
  });
});
