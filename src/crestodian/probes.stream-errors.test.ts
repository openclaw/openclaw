// Crestodian probe stream-error handling tests.
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return { ...actual, spawn: spawnMock };
});

describe("probeLocalCommand stream error handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers error listeners on stdout and stderr", async () => {
    const child = createMockChildProcess();
    const stdoutOn = vi.spyOn(child.stdout, "on");
    const stderrOn = vi.spyOn(child.stderr, "on");

    spawnMock.mockImplementationOnce(
      (_cmd: string, _args: readonly string[], _opts: SpawnOptions): ChildProcess => {
        process.nextTick(() => child.emit("close", 0));
        return child as unknown as ChildProcess;
      },
    );

    const { probeLocalCommand } = await import("./probes.js");

    await probeLocalCommand("echo", ["test"], { timeoutMs: 1000 });

    expect(stdoutOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(stderrOn).toHaveBeenCalledWith("error", expect.any(Function));
  });
});
