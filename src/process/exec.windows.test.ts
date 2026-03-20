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
      expect(captured?.[1][3]).toContain("chcp 65001>nul &&");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("does not build cmd.exe command line for non-wrapper runExec calls", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");

    execFileMock.mockImplementation((...params: unknown[]) => {
      const maybeCallback = params.at(-1);
      if (typeof maybeCallback === "function") {
        (maybeCallback as (err: Error | null, stdout: string, stderr: string) => void)(
          null,
          "ok",
          "",
        );
      }
    });

    try {
      await expect(runExec("grep", ["-P", "a|b"], 1000)).resolves.toBeDefined();
      const captured = execFileMock.mock.calls[0] as ExecCall | undefined;
      expect(captured?.[0]).toBe("grep");
      expect(captured?.[1]).toEqual(["-P", "a|b"]);
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
      expect(captured?.[1][3]).toContain("chcp 65001>nul &&");
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("treats utf-8 encoding alias as UTF-8 for runExec cmd wrapper", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

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
      await runExec("pnpm", ["--version"], { timeoutMs: 1000, encoding: "utf-8" });
      const captured = execFileMock.mock.calls[0] as ExecCall | undefined;
      expect(captured?.[1][3]).toContain("chcp 65001>nul &&");
    } finally {
      platformSpy.mockRestore();
    }
  });
});
