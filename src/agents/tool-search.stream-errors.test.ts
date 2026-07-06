// Regression tests for code-mode child stderr stream errors in Tool Search.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type MockSpawnChild = EventEmitter & {
  stdout?: EventEmitter & { setEncoding?: (enc: string) => void };
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  send?: (message: unknown, callback?: (error?: Error | null) => void) => boolean;
  connected?: boolean;
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
  child.connected = true;
  child.kill = vi.fn();
  child.send = vi.fn(() => true);
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

let testing: typeof import("./tool-search.js").testing;

describe("tool-search code-mode stream errors", () => {
  beforeAll(async () => {
    testing = (await import("./tool-search.js")).testing;
  });

  afterEach(() => {
    testing.setToolSearchCodeModeSupportedForTest(undefined);
    testing.setToolSearchMinCodeTimeoutMsForTest(undefined);
  });

  it("rejects when the code-mode child stderr emits an error", async () => {
    testing.setToolSearchCodeModeSupportedForTest(true);
    testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        process.nextTick(() => {
          stderr?.emit("error", new Error("stderr read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new testing.ToolSearchRuntime({}, testing.resolveToolSearchConfig({}));

    await expect(
      testing.runCodeModeChild({
        code: "return 1;",
        config: testing.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-error",
        runtime,
      }),
    ).rejects.toThrow("stderr read failed");
  });
});
