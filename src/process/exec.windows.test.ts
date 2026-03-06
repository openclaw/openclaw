import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());

// Ensure npm argv resolution path exists for Windows tests (portable across hosts).
existsSyncMock.mockReturnValue(true);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
    execFile: execFileMock,
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

import { runCommandWithTimeout, runExec } from "./exec.js";

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
  afterEach(() => {
    spawnMock.mockReset();
    execFileMock.mockReset();
    existsSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it("quotes args and enables windowsVerbatimArguments for node + npm-cli.js when argv contains spaces", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const comspec = process.env.ComSpec ?? "cmd.exe";

    spawnMock.mockImplementation(
      (_command: string, _args: string[], _options: Record<string, unknown>) => createMockChild(),
    );

    try {
      await runCommandWithTimeout(
        ["node.exe", "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "pack", "foo"],
        { timeoutMs: 1000 },
      );

      const captured = spawnMock.mock.calls[0] as SpawnCall | undefined;
      if (!captured) {
        throw new Error("expected spawn to be called");
      }

      expect(captured[0]).toBe("node.exe");
      expect(captured[2].windowsVerbatimArguments).toBe(true);

      // argv[0] becomes `node.exe`, argv[1] is the npm-cli script
      // argv[0] is the npm-cli script; it should be quoted because it contains spaces.
      expect(captured[1][0]).toBe('"C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"');
    } finally {
      platformSpy.mockRestore();
      // Make sure we didn't accidentally route through cmd.exe wrapper.
      expect(spawnMock.mock.calls[0]?.[0]).not.toBe(comspec);
    }
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
