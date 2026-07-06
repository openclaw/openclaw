// Regression tests for stdout/stderr stream errors in probeLocalCommand.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type MockSpawnChild = EventEmitter & {
  stdout?: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stdout = new EventEmitter() as MockSpawnChild["stdout"];
  stdout!.setEncoding = vi.fn();
  const stderr = new EventEmitter() as MockSpawnChild["stderr"];
  stderr!.setEncoding = vi.fn();
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  return { child, stdout, stderr };
}

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const spawnLocal = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
      const { child } = createMockSpawnChild();
      return child as unknown as ChildProcess;
    },
  );
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnLocal as unknown as typeof import("node:child_process").spawn,
    },
  );
});

const spawnMock = vi.mocked(spawn);

let probeLocalCommand: typeof import("./probes.js").probeLocalCommand;

describe("crestodian probe stream errors", () => {
  beforeAll(async () => {
    ({ probeLocalCommand } = await import("./probes.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports stdout stream error as probe failure", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stdout } = createMockSpawnChild();
        process.nextTick(() => {
          stdout?.emit("error", new Error("stdout read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    const result = await probeLocalCommand("some-binary", ["--version"], { timeoutMs: 1_000 });
    expect(result.found).toBe(true);
    expect(result.error).toContain("stdout read failed");
  });

  it("reports stderr stream error as probe failure", async () => {
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("error", new Error("stderr read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    const result = await probeLocalCommand("some-binary", ["--version"], { timeoutMs: 1_000 });
    expect(result.found).toBe(true);
    expect(result.error).toContain("stderr read failed");
  });
});
