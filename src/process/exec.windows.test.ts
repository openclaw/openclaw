import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
    execFile: execFileMock,
  };
});

let runCommandWithTimeout: typeof import("./exec.js").runCommandWithTimeout;
let runExec: typeof import("./exec.js").runExec;

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  killed?: boolean;
};

function createMockChild(params?: { code?: number; signal?: NodeJS.Signals | null }): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  child.killed = false;
  queueMicrotask(() => {
    child.emit("close", params?.code ?? 0, params?.signal ?? null);
  });
  return child;
}

type SpawnCall = [string, string[], Record<string, unknown>];

type ExecCall = [
  string,
  string[],
  Record<string, unknown>,
  (err: Error | null, stdout: string, stderr: string) => void,
];

function expectCmdWrappedInvocation(params: {
  captured: SpawnCall | ExecCall | undefined;
  expectedComSpec: string;
}) {
  if (!params.captured) {
    throw new Error("expected command wrapper to be called");
  }
  expect(params.captured[0]).toBe(params.expectedComSpec);
  expect(params.captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  expect(params.captured[1][3]).toContain("pnpm.cmd --version");
  expect(params.captured[2].windowsVerbatimArguments).toBe(true);
}

describe("windows command wrapper behavior", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ runCommandWithTimeout, runExec } = await import("./exec.js"));
  });

  afterEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    vi.restoreAllMocks();
  });

  it("wraps .cmd commands via cmd.exe in runCommandWithTimeout", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = process.env.ComSpec ?? "cmd.exe";

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      const result = await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
      expectCmdWrappedInvocation({ captured, expectedComSpec });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("prepends chcp 65001 to cmd.exe commands in runCommandWithTimeout", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      // pnpm.cmd will trigger the cmd.exe wrapper
      await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1000 });
      const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
      expect(captured?.[0]).toBe(process.env.ComSpec ?? "cmd.exe");
      // Verify chcp 65001 is prepended to force UTF-8 mode
      expect(captured?.[1][3]).toContain("chcp 65001");
      expect(captured?.[1][3]).toContain("pnpm.cmd");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("uses cmd.exe wrapper with windowsVerbatimArguments in runExec for .cmd shims", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = process.env.ComSpec ?? "cmd.exe";

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    try {
      await runExec("pnpm", ["--version"], 1000);
      const captured = execFileMock.mock.calls[0] as ExecCall | undefined;
      expectCmdWrappedInvocation({ captured, expectedComSpec });
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("prepends chcp 65001 to cmd.exe commands for UTF-8 support", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = process.env.ComSpec ?? "cmd.exe";

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        cb(null, "ok", "");
      },
    );

    try {
      // pnpm.cmd will trigger the cmd.exe wrapper
      await runExec("pnpm", ["--version"], 1000);
      const captured = execFileMock.mock.calls[0] as ExecCall | undefined;
      expect(captured?.[0]).toBe(expectedComSpec);
      // Verify chcp 65001 is prepended to force UTF-8 mode
      expect(captured?.[1][3]).toContain("chcp 65001");
      expect(captured?.[1][3]).toContain("pnpm.cmd");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("uses utf8 encoding for non-cmd executables on Windows", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const pathSepSpy = vi.spyOn(path, "extname").mockReturnValue(".exe");

    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        // Verify that utf8 encoding is used for non-cmd executables
        expect(options.encoding).toBe("utf8");
        cb(null, "ok", "");
      },
    );

    try {
      // node.exe should not trigger cmd.exe wrapper, so utf8 should be used
      await runExec("node", ["--version"], 1000);
      expect(execFileMock).toHaveBeenCalled();
    } finally {
      platformSpy.mockRestore();
      pathSepSpy.mockRestore();
    }
  });
});
