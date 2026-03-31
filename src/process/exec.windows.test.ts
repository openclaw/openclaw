import { EventEmitter } from "node:events";
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
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  killed?: boolean;
};

function createMockChild(params?: {
  closeCode?: number | null;
  closeSignal?: NodeJS.Signals | null;
  exitCode?: number | null;
  exitCodeAfterClose?: number | null;
  exitCodeAfterCloseDelayMs?: number;
  signal?: NodeJS.Signals | null;
}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = params?.exitCode ?? params?.closeCode ?? 0;
  child.signalCode = params?.signal ?? null;
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  child.kill = vi.fn(() => true);
  child.pid = 1234;
  child.killed = false;
  queueMicrotask(() => {
    child.emit("close", params?.closeCode ?? 0, params?.closeSignal ?? params?.signal ?? null);
    if (params?.exitCodeAfterClose !== undefined) {
      setTimeout(() => {
        child.exitCode = params.exitCodeAfterClose ?? null;
      }, params.exitCodeAfterCloseDelayMs ?? 0);
    }
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

  it("keeps child exitCode when close reports null on Windows npm shims", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({ closeCode: null, exitCode: 0 });

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("waits for Windows exitCode settlement after close reports null", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
      exitCodeAfterClose: 0,
      exitCodeAfterCloseDelayMs: 50,
    });

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("treats shimmed Windows commands without a reported exit code as success when they close cleanly", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
    });

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.termination).toBe("exit");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("treats shimmed Windows commands without a reported exit code as success even when child.killed is true", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = createMockChild({
      closeCode: null,
      exitCode: null,
    });
    child.killed = true;

    spawnMock.mockImplementation(() => child);

    try {
      const result = await runCommandWithTimeout(["npm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.termination).toBe("exit");
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
});
