import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForDead } from "../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { withChildProcessOperation } from "./spawn-diagnostics.js";
import { useSpawnDiagnostics } from "./spawn-diagnostics.test-support.js";

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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const dimensions = { cols: 80, rows: 24 };
const diagnosticParams = { file: "/bin/bash", args: ["-c", "synthetic"], ...dimensions };

function expectSpawn(file: string, args: string[] | string, options: object) {
  expect(mocks.spawn).toHaveBeenCalledWith(file, args, expect.objectContaining(options));
}

function replaceValue(target: object, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, {
    ...(original ?? { configurable: true, writable: true }),
    value,
  });
  return {
    [Symbol.dispose]() {
      if (original) {
        Object.defineProperty(target, key, original);
      } else {
        Reflect.deleteProperty(target, key);
      }
    },
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function spawnDirectTerminalPty(
  overrides: Pick<Parameters<typeof spawnTerminalPty>[0], "file"> &
    Partial<Parameters<typeof spawnTerminalPty>[0]>,
): ReturnType<typeof spawnTerminalPty> {
  const params = { args: [], env: {}, ...dimensions, ...overrides };
  using runtime = replaceValue(process.versions, "bun", undefined);
  void runtime;
  return await spawnTerminalPty(params);
}

function createWindowsNpmShim(command: string) {
  const binDir = tempDirs.make("openclaw-terminal-pty-shim-");
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

const fakePty = (pid = 4321) => ({
  pid,
  write: vi.fn(),
  resize: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  onData: vi.fn(),
  onExit: vi.fn(),
  kill: vi.fn(),
});

describe("terminal PTY spawn diagnostics", () => {
  const { events, sampleAt } = useSpawnDiagnostics();
  const expectSample = (time: number, family?: string) => {
    sampleAt(time);
    expect(events).toEqual(
      family ? [expect.objectContaining({ family, operation: "agent.exec", count: 1 })] : [],
    );
  };

  it.each(["node-pty", "bun-native", "node-helper"] as const)(
    "counts an admitted %s PTY once with the agent owner",
    async (backend) => {
      const bunGlobalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Bun");
      const bunRuntime =
        (globalThis as typeof globalThis & { Bun?: { Terminal?: unknown } }).Bun ?? {};
      using runtime = replaceValue(
        process.versions,
        "bun",
        backend === "node-pty" ? undefined : "synthetic-bun",
      );
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const pty = fakePty();
      mocks.spawn.mockReturnValueOnce(pty);
      mocks.spawnBunTerminalPty.mockReturnValueOnce(pty);
      mocks.spawnNodeTerminalPty.mockResolvedValueOnce(pty);
      // The real Bun global is immutable; its Terminal capability is writable.
      using terminal = replaceValue(
        bunRuntime,
        "Terminal",
        backend === "bun-native" ? { prototype: { pause() {} } } : undefined,
      );
      using global = !bunGlobalDescriptor ? replaceValue(globalThis, "Bun", bunRuntime) : undefined;
      void [runtime, terminal, global];
      await withChildProcessOperation("agent.exec", () => spawnTerminalPty(diagnosticParams));
      expectSample(60_000, "bash");
    },
  );

  it("retains preparation ownership and excludes failed or denied native launches", async () => {
    using runtime = replaceValue(process.versions, "bun", undefined);
    void runtime;
    const launch = await withChildProcessOperation("agent.exec", () =>
      prepareTerminalPty(diagnosticParams),
    );
    expectSample(60_000);
    mocks.spawn.mockReturnValueOnce(fakePty());
    launch();
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("native PTY unavailable");
    });
    await expect(spawnTerminalPty(diagnosticParams)).rejects.toThrow("native PTY unavailable");
    await expect(
      spawnTerminalPty(diagnosticParams, {
        assertCurrent: () => {
          throw new Error("PTY launch denied");
        },
      }),
    ).rejects.toThrow("PTY launch denied");
    expectSample(120_000, "bash");
  });

  it.each(["data", "silent-exit", "failed-exit"] as const)(
    "settles deferred Windows PTY attribution once on %s",
    async (outcome) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const pty = fakePty(0);
      const dataSubscription = { dispose: vi.fn() };
      const exitSubscription = { dispose: vi.fn() };
      pty.onData.mockReturnValueOnce(dataSubscription);
      pty.onExit.mockReturnValueOnce(exitSubscription);
      mocks.spawn.mockReturnValueOnce(pty);
      await withChildProcessOperation("agent.exec", () =>
        spawnTerminalPty({ file: "powershell.exe", args: [], ...dimensions }),
      );
      const onData: (data: string) => void = pty.onData.mock.calls[0][0];
      const onExit: () => void = pty.onExit.mock.calls[0][0];
      expectSample(60_000);
      if (outcome !== "failed-exit") {
        pty.pid = 4321;
      }
      if (outcome === "data") {
        onData("synthetic output");
      }
      onExit();
      onData("late synthetic output");
      expectSample(120_000, outcome === "failed-exit" ? undefined : "powershell");
      expect(dataSubscription.dispose).toHaveBeenCalledOnce();
      expect(exitSubscription.dispose).toHaveBeenCalledOnce();
    },
  );
});

it("uses the PTY handle for non-terminating signals", async () => {
  const pty = fakePty();
  mocks.spawn.mockReturnValueOnce(pty);
  const handle = await spawnDirectTerminalPty({ file: "/bin/sh" });
  handle.kill("SIGHUP");
  expect(mocks.signalPtySessionTree).not.toHaveBeenCalled();
  expect(pty.kill.mock.calls).toEqual([process.platform === "win32" ? [] : ["SIGHUP"]]);
});

describe("terminal PTY invocation", () => {
  beforeEach(() => {
    mocks.spawn.mockReturnValueOnce(fakePty());
  });

  it.each([
    ["TERM", "dumb", "xterm-256color"],
    ["Term", "screen-256color", "screen-256color"],
  ])("normalizes %s=%s to %s for a real PTY", async (key, value, name) => {
    const windows = key === "Term";
    if (windows) {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    }
    const file = windows ? "powershell.exe" : "/usr/bin/codex";
    const args = windows ? [] : ["resume", "thread"];
    await spawnDirectTerminalPty({ file, args, env: { [key]: value } });
    const env = { TERM: name };
    expectSpawn(file, args, { name, env: windows ? env : expect.objectContaining(env) });
  });

  it("wraps Windows .bat shims through ComSpec", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const comspec = "C:\\Windows\\System32\\cmd.exe";
    await spawnDirectTerminalPty({
      file: "C:\\Program Files\\Codex\\codex.bat",
      args: ["resume", "thread title"],
      env: { COMSPEC: comspec },
    });
    expectSpawn(
      comspec,
      '/d /s /c ""C:\\Program Files\\Codex\\codex.bat" "resume" "thread title""',
      dimensions,
    );
  });

  it.runIf(process.platform === "win32").each(["node", "packaged", "missing"] as const)(
    "resolves npm shims from a %s host without shell expansion",
    async (host) => {
      const { entrypoint, shimPath } = createWindowsNpmShim("codex");
      let nodePath = host === "node" ? resolveTestNodeExecPath() : "";
      let nodeDir = path.dirname(nodePath);
      if (host !== "node") {
        nodeDir =
          host === "missing"
            ? path.dirname(shimPath)
            : tempDirs.make("openclaw-terminal-pty-node-");
        nodePath = path.join(nodeDir, "node.exe");
        if (host === "packaged") {
          fs.copyFileSync(resolveTestNodeExecPath(), nodePath);
        }
        vi.spyOn(process, "execPath", "get").mockReturnValue(
          "C:\\Program Files\\OpenClaw\\openclaw.exe",
        );
      }
      const args = host === "node" ? ["exec", "--", "Fix A&B and 100%"] : ["--", "literal"];
      const launch = spawnDirectTerminalPty({
        file: shimPath,
        args,
        env: { PATH: nodeDir, PATHEXT: ".EXE;.CMD" },
      });
      if (host === "missing") {
        await expect(launch).rejects.toThrow(/Node executable/);
        expect(mocks.spawn).not.toHaveBeenCalled();
        return;
      }
      await launch;
      expect(mocks.spawn).toHaveBeenCalledOnce();
      const [command, argv, options] = mocks.spawn.mock.calls[0] ?? [];
      if (host === "node") {
        expect(fs.realpathSync.native(String(command)).toLowerCase()).toBe(
          fs.realpathSync.native(nodePath).toLowerCase(),
        );
      } else {
        expect(String(command).toLowerCase()).toBe(nodePath.toLowerCase());
      }
      expect(argv).toEqual([entrypoint, ...args]);
      expect(options).toMatchObject({ cols: 80, rows: 24 });
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps unknown batch wrappers on the guarded cmd path",
    async () => {
      const tempDir = tempDirs.make("openclaw-terminal-pty-custom-");
      const wrapperPath = path.join(tempDir, "custom.cmd");
      fs.writeFileSync(wrapperPath, "@ECHO off\r\necho custom\r\n", "utf8");
      await expect(
        spawnDirectTerminalPty({
          file: wrapperPath,
          args: ["Fix A&B and 100%"],
          env: { COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
        }),
      ).rejects.toThrow("Unsafe Windows cmd.exe argument");
      expect(mocks.spawn).not.toHaveBeenCalled();
    },
  );

  it.runIf(process.platform === "win32")(
    "passes a bare-only native host directly to the PTY spawn owner",
    async () => {
      const tempDir = tempDirs.make("openclaw-terminal-pty-bare-");
      const barePath = path.join(tempDir, "bare-host");
      fs.copyFileSync(process.execPath, barePath);
      await spawnDirectTerminalPty({
        file: barePath,
        args: ["--version"],
      });
      expectSpawn(barePath, ["--version"], dimensions);
    },
  );
});

it.runIf(process.platform !== "win32")(
  "kills a background process group within the PTY session",
  async ({ signal }) => {
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
      ...dimensions,
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
      const fields = process.platform === "darwin" ? "pid=,pgid=,tty=" : "pid=,pgid=,sid=";
      const ps = spawnSync("ps", ["-o", fields, "-p", `${shellPid},${childPid}`], {
        encoding: "utf8",
      });
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
      // The PTY exit callback owns the shell, but kill() only signals foreign session members.
      await waitForDead(childPid, signal);
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
  },
);
