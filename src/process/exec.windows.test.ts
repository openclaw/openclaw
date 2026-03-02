import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("windows command wrapper behavior", () => {
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
      const captured = spawnMock.mock.calls[0] as
        | [string, string[], Record<string, unknown>]
        | undefined;
      if (!captured) {
        throw new Error("spawn mock was not called");
      }
      expect(captured[0]).toBe(expectedComSpec);
      expect(captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(captured[1][3]).toContain("pnpm.cmd --version");
      expect(captured[2].windowsVerbatimArguments).toBe(true);
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
      const captured = execFileMock.mock.calls[0] as
        | [
            string,
            string[],
            Record<string, unknown>,
            (err: Error | null, stdout: string, stderr: string) => void,
          ]
        | undefined;
      if (!captured) {
        throw new Error("execFile mock was not called");
      }
      expect(captured[0]).toBe(expectedComSpec);
      expect(captured[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(captured[1][3]).toContain("pnpm.cmd --version");
      expect(captured[2].windowsVerbatimArguments).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
