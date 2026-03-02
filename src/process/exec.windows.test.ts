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
    let captured: { command: string; args: string[]; options: Record<string, unknown> } | null =
      null;

    spawnMock.mockImplementation(
      (command: string, args: string[], options: Record<string, unknown>) => {
        captured = { command, args, options };
        return createMockChild();
      },
    );

    try {
      const result = await runCommandWithTimeout(["pnpm", "--version"], { timeoutMs: 1000 });
      expect(result.code).toBe(0);
      expect(captured?.command).toBe(expectedComSpec);
      expect(captured?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(captured?.args[3]).toContain("pnpm.cmd --version");
      expect(captured?.options.windowsVerbatimArguments).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("uses cmd.exe wrapper with windowsVerbatimArguments in runExec for .cmd shims", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const expectedComSpec = process.env.ComSpec ?? "cmd.exe";
    let captured: { command: string; args: string[]; options: Record<string, unknown> } | null =
      null;

    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        options: Record<string, unknown>,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => {
        captured = { command, args, options };
        cb(null, "ok", "");
      },
    );

    try {
      await runExec("pnpm", ["--version"], 1000);
      expect(captured?.command).toBe(expectedComSpec);
      expect(captured?.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(captured?.args[3]).toContain("pnpm.cmd --version");
      expect(captured?.options.windowsVerbatimArguments).toBe(true);
    } finally {
      platformSpy.mockRestore();
    }
  });
});
