import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createChildAdapter } from "./child.js";

const spawnWithFallbackMock = vi.fn();

vi.mock("../../../process/spawn-fallback.js", () => ({
  spawnWithFallback: (params: any) => spawnWithFallbackMock(params),
}));

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  Object.defineProperty(child, "exitCode", { value: null, configurable: true, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  child.kill = killMock as ChildProcess["kill"];
  const emitClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    Object.defineProperty(child, "exitCode", { value: code, configurable: true, writable: true });
    Object.defineProperty(child, "signalCode", {
      value: signal,
      configurable: true,
      writable: true,
    });
    child.emit("exit", code, signal);
  };
  return { child, killMock, emitClose, emitExit };
}

async function createAdapterHarness(params?: {
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { child, killMock, emitClose, emitExit } = createStubChild(params?.pid);
  spawnWithFallbackMock.mockResolvedValue({
    child,
    command: params?.argv?.[0] ?? "test",
    args: params?.argv?.slice(1) ?? [],
  });

  const adapter = await createChildAdapter({
    argv: params?.argv ?? ["test"],
    env: params?.env,
  });

  return { adapter, child, killMock, emitClose, emitExit };
}

describe("ChildProcessAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("spawns a child process with provided arguments and environment", async () => {
    const argv = ["node", "-e", "console.log('hello')"];
    const env = { TEST: "123" };
    const { adapter, child } = await createAdapterHarness({ argv, env });

    expect(spawnWithFallbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "node",
        args: ["-e", "console.log('hello')"],
        env: expect.objectContaining(env),
      }),
    );
    expect(adapter.pid).toBe(child.pid);
  });

  it("proxies stdout and stderr streams", async () => {
    const { adapter, child } = await createAdapterHarness();
    const stdoutData: string[] = [];
    const stderrData: string[] = [];

    adapter.onStdout((chunk) => stdoutData.push(chunk));
    adapter.onStderr((chunk) => stderrData.push(chunk));

    child.stdout?.emit("data", Buffer.from("out"));
    child.stderr?.emit("data", Buffer.from("err"));

    expect(stdoutData.join("")).toBe("out");
    expect(stderrData.join("")).toBe("err");
  });

  it("handles process exit", async () => {
    const { adapter, emitExit } = await createAdapterHarness();
    const waitPromise = adapter.wait();

    emitExit(0);
    const result = await waitPromise;
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("handles process close", async () => {
    const { adapter, emitClose } = await createAdapterHarness();
    const waitPromise = adapter.wait();

    emitClose(1, "SIGTERM");
    const result = await waitPromise;
    expect(result.code).toBe(1);
    expect(result.signal).toBe("SIGTERM");
  });

  it("kills the child process", async () => {
    const { adapter, killMock } = await createAdapterHarness();
    adapter.kill("SIGKILL");
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });
});
