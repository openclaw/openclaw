import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import { runCommandWithTimeout } from "./exec.js";

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  killed?: boolean;
};

function createMockChild(params?: { stdout?: string; stderr?: string; code?: number }): MockChild {
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
    if (params?.stdout) {
      child.stdout.emit("data", Buffer.from(params.stdout));
    }
    if (params?.stderr) {
      child.stderr.emit("data", Buffer.from(params.stderr));
    }
    child.emit("close", params?.code ?? 0, null);
  });
  return child;
}

describe("runCommandWithTimeout mirrored output", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("mirrors stdout while still capturing it", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const stdoutSpy = vi.fn(() => true);
    process.stdout.write = stdoutSpy as typeof process.stdout.write;
    spawnMock.mockImplementation(() => createMockChild({ stdout: "hello" }));

    try {
      const result = await runCommandWithTimeout(["codex", "login"], {
        timeoutMs: 1_000,
        mirrorStdout: true,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("hello");
      expect(stdoutSpy).toHaveBeenCalledWith(expect.any(Buffer));
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  it("mirrors stderr while still capturing it", async () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrSpy = vi.fn(() => true);
    process.stderr.write = stderrSpy as typeof process.stderr.write;
    spawnMock.mockImplementation(() => createMockChild({ stderr: "oops" }));

    try {
      const result = await runCommandWithTimeout(["codex", "login"], {
        timeoutMs: 1_000,
        mirrorStderr: true,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("oops");
      expect(stderrSpy).toHaveBeenCalledWith(expect.any(Buffer));
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});
