import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { emitChildProcessSpawnSample, withChildProcessOperation } from "./spawn-diagnostics.js";

const mocks = vi.hoisted(() => ({
  signalPtySessionTree: vi.fn(),
  signalProcessTree: vi.fn(),
  spawn: vi.fn(),
  spawnBunTerminalPty: vi.fn(),
  spawnNodeTerminalPty: vi.fn(),
}));

vi.mock("./kill-tree.js", () => ({
  signalProcessTree: mocks.signalProcessTree,
  signalPtySessionTree: mocks.signalPtySessionTree,
}));
vi.mock("@lydell/node-pty", () => ({ spawn: mocks.spawn }));
vi.mock("./terminal-pty-bun.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./terminal-pty-bun.js")>()),
  spawnBunTerminalPty: mocks.spawnBunTerminalPty,
}));
// mock-isolation: Avoid importing the Node PTY backend under synthetic Bun and platform globals.
vi.mock("./terminal-pty-node.js", () => ({
  spawnNodeTerminalPty: mocks.spawnNodeTerminalPty,
}));

const { prepareTerminalPty, spawnTerminalPty } = await import("./terminal-pty.js");

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { force: true, recursive: true });
  }
});

async function spawnDirectTerminalPty(
  params: Parameters<typeof spawnTerminalPty>[0],
): ReturnType<typeof spawnTerminalPty> {
  const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  if (!bunDescriptor) {
    return await spawnTerminalPty(params);
  }
  Object.defineProperty(process.versions, "bun", { ...bunDescriptor, value: undefined });
  try {
    return await spawnTerminalPty(params);
  } finally {
    Object.defineProperty(process.versions, "bun", bunDescriptor);
  }
}

function createWindowsNpmShim(command: string) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-shim-"));
  tempDirs.push(binDir);
  const entrypoint = path.join(binDir, "node_modules", "@openai", command, "bin", `${command}.js`);
  fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
  fs.writeFileSync(entrypoint, "", "utf8");
  const relativeEntrypoint = path.relative(binDir, entrypoint).replaceAll(path.sep, "\\");
  const shimPath = path.join(binDir, `${command}.cmd`);
  fs.writeFileSync(
    shimPath,
    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n" +
      'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${relativeEntrypoint}" %*\r\n`,
    "utf8",
  );
  return { entrypoint, shimPath };
}

function fakePty(pid = 4321) {
  return {
    pid,
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
  };
}

async function spawnFakePty(pid = 4321) {
  const pty = fakePty(pid);
  mocks.spawn.mockReturnValueOnce(pty);
  const handle = await spawnDirectTerminalPty({
    file: "/bin/sh",
    args: [],
    env: {},
    cols: 80,
    rows: 24,
  });
  return { handle, pty };
}

describe("terminal PTY spawn diagnostics", () => {
  let now = 0;
  let events: DiagnosticEventPayload[];
  let stop: () => void;

  beforeEach(() => {
    mocks.spawn.mockReset();
    mocks.spawnBunTerminalPty.mockReset();
    mocks.spawnNodeTerminalPty.mockReset();
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    resetDiagnosticEventsForTest();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    setDiagnosticsEnabledForProcess(true);
    events = [];
    stop = onDiagnosticEvent((event) => {
      if (event.type === "diagnostic.child_process.spawn") {
        events.push(event);
      }
    });
  });

  afterEach(() => {
    stop();
    setDiagnosticsEnabledForProcess(false);
    emitChildProcessSpawnSample();
    resetDiagnosticEventsForTest();
  });

  it.each(["node-pty", "bun-native", "node-helper"] as const)(
    "counts an admitted %s PTY once with the agent owner",
    async (backend) => {
      const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
      const bunGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
      const bunRuntime =
        (globalThis as typeof globalThis & { Bun?: { Terminal?: unknown } }).Bun ?? {};
      const terminalDescriptor = Object.getOwnPropertyDescriptor(bunRuntime, "Terminal");
      Object.defineProperty(process.versions, "bun", {
        configurable: true,
        value: backend === "node-pty" ? undefined : "synthetic-bun",
      });
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const pty = fakePty();
      mocks.spawn.mockReturnValueOnce(pty);
      mocks.spawnBunTerminalPty.mockReturnValueOnce(pty);
      mocks.spawnNodeTerminalPty.mockResolvedValueOnce(pty);
      // The real Bun global is immutable; its Terminal capability is writable.
      Object.defineProperty(bunRuntime, "Terminal", {
        ...(terminalDescriptor ?? { configurable: true, writable: true }),
        value: backend === "bun-native" ? { prototype: { pause() {} } } : undefined,
      });
      if (!bunGlobalDescriptor) {
        vi.stubGlobal("Bun", bunRuntime);
      }
      try {
        await withChildProcessOperation("agent.exec", () =>
          spawnTerminalPty({ file: "/bin/bash", args: ["-c", "synthetic"], cols: 80, rows: 24 }),
        );
      } finally {
        platform.mockRestore();
        if (terminalDescriptor) {
          Object.defineProperty(bunRuntime, "Terminal", terminalDescriptor);
        } else {
          Reflect.deleteProperty(bunRuntime, "Terminal");
        }
        if (!bunGlobalDescriptor) {
          vi.unstubAllGlobals();
        }
        if (bunDescriptor) {
          Object.defineProperty(process.versions, "bun", bunDescriptor);
        } else {
          Reflect.deleteProperty(process.versions, "bun");
        }
      }
      now = 60_000;
      emitChildProcessSpawnSample();
      expect(events).toEqual([
        expect.objectContaining({ family: "bash", operation: "agent.exec", count: 1 }),
      ]);
    },
  );

  it("retains preparation ownership and excludes failed or denied native launches", async () => {
    const params = { file: "/bin/bash", args: ["-c", "synthetic"], cols: 80, rows: 24 };
    const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
    if (bunDescriptor) {
      Object.defineProperty(process.versions, "bun", { ...bunDescriptor, value: undefined });
    }
    try {
      const launch = await withChildProcessOperation("agent.exec", () =>
        prepareTerminalPty(params),
      );
      now = 60_000;
      emitChildProcessSpawnSample();
      expect(events).toEqual([]);
      mocks.spawn.mockReturnValueOnce(fakePty());
      launch();
      mocks.spawn.mockImplementationOnce(() => {
        throw new Error("native PTY unavailable");
      });
      await expect(spawnTerminalPty(params)).rejects.toThrow("native PTY unavailable");
      await expect(
        spawnTerminalPty(params, {
          assertCurrent: () => {
            throw new Error("PTY launch denied");
          },
        }),
      ).rejects.toThrow("PTY launch denied");
      now = 120_000;
      emitChildProcessSpawnSample();
      expect(events).toEqual([
        expect.objectContaining({ family: "bash", operation: "agent.exec", count: 1 }),
      ]);
    } finally {
      if (bunDescriptor) {
        Object.defineProperty(process.versions, "bun", bunDescriptor);
      }
    }
  });

  it.each(["data", "silent-exit", "failed-exit"] as const)(
    "settles deferred Windows PTY attribution once on %s",
    async (outcome) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const pty = fakePty(0);
      const dataSubscription = { dispose: vi.fn() };
      const exitSubscription = { dispose: vi.fn() };
      let onData: (data: string) => void = () => {};
      let onExit: () => void = () => {};
      pty.onData.mockImplementation((listener: typeof onData) => {
        onData = listener;
        return dataSubscription;
      });
      pty.onExit.mockImplementation((listener: typeof onExit) => {
        onExit = listener;
        return exitSubscription;
      });
      mocks.spawn.mockReturnValueOnce(pty);
      await withChildProcessOperation("agent.exec", () =>
        spawnTerminalPty({ file: "powershell.exe", args: [], cols: 80, rows: 24 }),
      );
      now = 60_000;
      emitChildProcessSpawnSample();
      expect(events).toEqual([]);
      if (outcome !== "failed-exit") {
        pty.pid = 4321;
      }
      if (outcome === "data") {
        onData("synthetic output");
      }
      onExit();
      onData("late synthetic output");
      now = 120_000;
      emitChildProcessSpawnSample();
      expect(events).toEqual(
        outcome === "failed-exit"
          ? []
          : [expect.objectContaining({ family: "powershell", operation: "agent.exec", count: 1 })],
      );
      expect(dataSubscription.dispose).toHaveBeenCalledOnce();
      expect(exitSubscription.dispose).toHaveBeenCalledOnce();
    },
  );
});

describe("terminal PTY teardown", () => {
  beforeEach(() => {
    mocks.signalPtySessionTree.mockReset();
    mocks.signalProcessTree.mockReset();
    mocks.spawn.mockReset();
  });

  it("uses the PTY handle for non-terminating signals", async () => {
    const { handle, pty } = await spawnFakePty();
    handle.kill("SIGHUP");
    expect(mocks.signalPtySessionTree).not.toHaveBeenCalled();
    if (process.platform === "win32") {
      expect(pty.kill).toHaveBeenCalledWith();
    } else {
      expect(pty.kill).toHaveBeenCalledWith("SIGHUP");
    }
  });
});

describe("terminal PTY invocation", () => {
  const nonInteractiveEnvironments: Array<Record<string, string>> = [{ TERM: "dumb" }];

  beforeEach(() => {
    mocks.spawn.mockReset();
  });

  it.each(nonInteractiveEnvironments)(
    "upgrades non-interactive TERM for a real PTY: %o",
    async (env) => {
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnDirectTerminalPty({
        file: "/usr/bin/codex",
        args: ["resume", "thread"],
        env,
        cols: 80,
        rows: 24,
      });

      expect(mocks.spawn).toHaveBeenCalledWith(
        "/usr/bin/codex",
        ["resume", "thread"],
        expect.objectContaining({
          name: "xterm-256color",
          env: expect.objectContaining({ TERM: "xterm-256color" }),
        }),
      );
    },
  );

  it("canonicalizes a case-insensitive Windows TERM key", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.spawn.mockReturnValueOnce(fakePty());

    await spawnDirectTerminalPty({
      file: "powershell.exe",
      args: [],
      env: { Term: "screen-256color" },
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      "powershell.exe",
      [],
      expect.objectContaining({
        name: "screen-256color",
        env: { TERM: "screen-256color" },
      }),
    );
  });

  it.each([
    [".bat", { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }, "C:\\Windows\\System32\\cmd.exe"],
  ])("wraps Windows %s shims through ComSpec", async (extension, env, expectedComSpec) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.spawn.mockReturnValueOnce(fakePty());

    await spawnDirectTerminalPty({
      file: `C:\\Program Files\\Codex\\codex${extension}`,
      args: ["resume", "thread title"],
      env,
      cols: 80,
      rows: 24,
    });

    expect(mocks.spawn).toHaveBeenCalledWith(
      expectedComSpec,
      `/d /s /c ""C:\\Program Files\\Codex\\codex${extension}" "resume" "thread title""`,
      expect.objectContaining({ cols: 80, rows: 24 }),
    );
  });

  it.runIf(process.platform === "win32")(
    "passes arbitrary Codex initial-message text literally through an npm shim",
    async () => {
      const { entrypoint, shimPath } = createWindowsNpmShim("codex");
      const nodePath = resolveTestNodeExecPath();
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnDirectTerminalPty({
        file: shimPath,
        args: ["exec", "--", "Fix A&B and 100%"],
        env: { PATH: path.dirname(nodePath), PATHEXT: ".EXE;.CMD" },
        cols: 80,
        rows: 24,
      });

      expect(mocks.spawn).toHaveBeenCalledOnce();
      const [command, argv, options] = mocks.spawn.mock.calls[0] ?? [];
      expect(fs.realpathSync.native(String(command)).toLowerCase()).toBe(
        fs.realpathSync.native(nodePath).toLowerCase(),
      );
      expect(argv).toEqual([entrypoint, "exec", "--", "Fix A&B and 100%"]);
      expect(options).toMatchObject({ cols: 80, rows: 24 });
    },
  );

  it.runIf(process.platform === "win32")(
    "uses PATH node.exe instead of a packaged non-Node host for an npm shim",
    async () => {
      const { entrypoint, shimPath } = createWindowsNpmShim("codex");
      const nodeDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-node-"));
      tempDirs.push(nodeDir);
      const nodePath = path.join(nodeDir, "node.exe");
      fs.copyFileSync(resolveTestNodeExecPath(), nodePath);
      vi.spyOn(process, "execPath", "get").mockReturnValue(
        "C:\\Program Files\\OpenClaw\\openclaw.exe",
      );
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnDirectTerminalPty({
        file: shimPath,
        args: ["--", "literal"],
        env: { PATH: nodeDir, PATHEXT: ".EXE;.CMD" },
        cols: 80,
        rows: 24,
      });

      const [command, argv] = mocks.spawn.mock.calls[0] ?? [];
      expect(String(command).toLowerCase()).toBe(nodePath.toLowerCase());
      expect(argv).toEqual([entrypoint, "--", "literal"]);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed when an npm shim has no Node executable",
    async () => {
      const { shimPath } = createWindowsNpmShim("codex");
      vi.spyOn(process, "execPath", "get").mockReturnValue(
        "C:\\Program Files\\OpenClaw\\openclaw.exe",
      );

      await expect(
        spawnDirectTerminalPty({
          file: shimPath,
          args: ["--", "literal"],
          env: { PATH: path.dirname(shimPath), PATHEXT: ".EXE;.CMD" },
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow(/Node executable/);
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps unknown batch wrappers on the guarded cmd path",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-custom-"));
      tempDirs.push(tempDir);
      const wrapperPath = path.join(tempDir, "custom.cmd");
      fs.writeFileSync(wrapperPath, "@ECHO off\r\necho custom\r\n", "utf8");

      await expect(
        spawnDirectTerminalPty({
          file: wrapperPath,
          args: ["Fix A&B and 100%"],
          env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
          cols: 80,
          rows: 24,
        }),
      ).rejects.toThrow("Unsafe Windows cmd.exe argument");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "passes a bare-only native host directly to the PTY spawn owner",
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-terminal-pty-bare-"));
      tempDirs.push(tempDir);
      const barePath = path.join(tempDir, "bare-host");
      fs.copyFileSync(process.execPath, barePath);
      mocks.spawn.mockReturnValueOnce(fakePty());

      await spawnDirectTerminalPty({
        file: barePath,
        args: ["--version"],
        env: {},
        cols: 80,
        rows: 24,
      });

      expect(mocks.spawn).toHaveBeenCalledWith(
        barePath,
        ["--version"],
        expect.objectContaining({ cols: 80, rows: 24 }),
      );
    },
  );
});

// The PTY exit callback owns the shell, but kill() only signals foreign session members.
async function waitForPidToExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (isPidAlive(pid)) {
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`Timed out waiting for PTY descendant ${pid} to exit`, { cause: error });
    }
    throw error;
  }
}

describe.runIf(process.platform !== "win32")("terminal PTY process-session teardown", () => {
  it("kills a background job in a distinct process group within the PTY session", async ({
    signal,
  }) => {
    vi.resetModules();
    vi.doUnmock("@lydell/node-pty");
    vi.doUnmock("./kill-tree.js");
    vi.doUnmock("./terminal-pty-bun.js");
    vi.doUnmock("./terminal-pty-node.js");
    const { spawnTerminalPty: spawnRealTerminalPty } = await import("./terminal-pty.js");
    const handle = await spawnRealTerminalPty({
      file: "/bin/bash",
      args: ["-l"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir() },
      cols: 80,
      rows: 24,
    });
    let output = "";
    let shellPid: number | undefined;
    let childPid: number | undefined;
    const ready = createDeferred();
    const exited = createDeferred();
    handle.onExit(() => exited.resolve());
    handle.onData((chunk) => {
      output += chunk;
      const match = output.match(/__OPENCLAW_PIDS__\s+(\d+)\s+(\d+)\r?\n/u);
      if (match) {
        shellPid = Number(match[1]);
        childPid = Number(match[2]);
        ready.resolve();
      }
    });

    try {
      handle.write(
        'sleep 300 & child=$(jobs -p); printf \'__OPENCLAW_PIDS__ %s %s\\n\' "$$" "$child"\r',
      );
      await withinTest(
        awaitGateBeforeSettlement(ready.promise, exited.promise, "missing PTY process ids"),
        signal,
      );
      if (!shellPid || !childPid) {
        throw new Error("missing PTY process ids");
      }
      const ps = spawnSync(
        "ps",
        [
          "-o",
          process.platform === "darwin" ? "pid=,pgid=,tty=" : "pid=,pgid=,sid=",
          "-p",
          `${shellPid},${childPid}`,
        ],
        { encoding: "utf8" },
      );
      const rows = ps.stdout
        .trim()
        .split("\n")
        .map((line) => {
          const [pid, pgid, session] = line.trim().split(/\s+/u);
          return { pid: Number(pid), pgid: Number(pgid), session };
        });
      const shell = rows.find((row) => row.pid === shellPid);
      const child = rows.find((row) => row.pid === childPid);
      expect(shell).toMatchObject({ pid: shellPid, pgid: shellPid });
      expect(child?.pgid).not.toBe(shellPid);
      expect(child?.session).toBe(shell?.session);
      if (process.platform !== "darwin") {
        expect(Number(shell?.session)).toBe(shellPid);
      }

      handle.kill();
      await withinTest(exited.promise, signal);
      expect(isPidAlive(shellPid)).toBe(false);
      await waitForPidToExit(childPid, signal);
      expect(isPidAlive(childPid)).toBe(false);
    } finally {
      try {
        handle.kill();
      } catch {
        // Already gone.
      }
      killPidIfAlive(childPid);
      killPidIfAlive(shellPid);
    }
  });
});
