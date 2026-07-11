// Crestodian probe stream-error handling tests.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

type MockChildProcess = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn: spawnMock };
});

describe("probeLocalCommand stream error handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("keeps child close authoritative when stdout and stderr emit errors", async () => {
    const child = createMockChildProcess();

    spawnMock.mockImplementationOnce(
      (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => {
        process.nextTick(() => {
          child.stdout.emit("error", new Error("stdout closed"));
          child.stderr.emit("error", new Error("stderr closed"));
          child.emit("close", 0);
        });
        return child as unknown as ChildProcess;
      },
    );

    const { probeLocalCommand } = await import("./probes.js");

    await expect(probeLocalCommand("echo", ["test"], { timeoutMs: 1000 })).resolves.toEqual({
      command: "echo",
      found: true,
      version: undefined,
      error: undefined,
    });
  });
});
