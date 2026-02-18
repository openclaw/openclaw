import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnWithFallbackMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: (...args: unknown[]) => spawnWithFallbackMock(...args),
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: (...args: unknown[]) => killProcessTreeMock(...args),
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  child.kill = killMock as ChildProcess["kill"];
  return { child, killMock };
}

async function createAdapterHarness(params?: {
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const { createChildAdapter } = await import("./child.js");
  const { child, killMock } = createStubChild(params?.pid);
  spawnWithFallbackMock.mockResolvedValue({
    child,
    usedFallback: false,
  });
  const adapter = await createChildAdapter({
    argv: params?.argv ?? ["node", "-e", "setTimeout(() => {}, 1000)"],
    env: params?.env,
    stdinMode: "pipe-open",
  });
  return { adapter, killMock };
}

describe("createChildAdapter", () => {
  beforeEach(() => {
    spawnWithFallbackMock.mockReset();
    killProcessTreeMock.mockReset();
  });

  it("uses process-tree kill for default SIGKILL", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 4321 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    // On Windows, detached defaults to false (headless Scheduled Task compat);
    // on POSIX, detached is true with a no-detach fallback.
    if (process.platform === "win32") {
      expect(spawnArgs.options?.detached).toBe(false);
      expect(spawnArgs.fallbacks).toEqual([]);
    } else {
      expect(spawnArgs.options?.detached).toBe(true);
      expect(spawnArgs.fallbacks?.[0]?.options?.detached).toBe(false);
    }

    adapter.kill();

    expect(killProcessTreeMock).toHaveBeenCalledWith(4321);
    expect(killMock).not.toHaveBeenCalled();
  });

  it("uses direct child.kill for non-SIGKILL signals", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGTERM");

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps inherited env when no override env is provided", async () => {
    await createAdapterHarness({
      pid: 3333,
      argv: ["node", "-e", "process.exit(0)"],
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: NodeJS.ProcessEnv };
    };
    expect(spawnArgs.options?.env).toBeUndefined();
  });

  it("destroys stdio streams on dispose", async () => {
    const { child } = createStubChild(5555);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const { createChildAdapter } = await import("./child.js");
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "1"],
      stdinMode: "pipe-open",
    });

    expect(child.stdin!.destroyed).toBe(false);
    expect(child.stdout!.destroyed).toBe(false);
    expect(child.stderr!.destroyed).toBe(false);

    adapter.dispose();

    expect(child.stdin!.destroyed).toBe(true);
    expect(child.stdout!.destroyed).toBe(true);
    expect(child.stderr!.destroyed).toBe(true);
  });

  it("dispose is safe when streams are already destroyed", async () => {
    const { child } = createStubChild(6666);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const { createChildAdapter } = await import("./child.js");
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "1"],
      stdinMode: "pipe-open",
    });

    // Manually destroy all streams first
    child.stdin!.destroy();
    child.stdout!.destroy();
    child.stderr!.destroy();

    expect(child.stdin!.destroyed).toBe(true);
    expect(child.stdout!.destroyed).toBe(true);
    expect(child.stderr!.destroyed).toBe(true);

    // Calling dispose again should not throw
    adapter.dispose();
  });

  it("dispose is safe when child process already exited", async () => {
    const { child } = createStubChild(7777);
    spawnWithFallbackMock.mockResolvedValue({ child, usedFallback: false });
    const { createChildAdapter } = await import("./child.js");
    const adapter = await createChildAdapter({
      argv: ["node", "-e", "1"],
      stdinMode: "pipe-open",
    });

    // Simulate child exit by destroying streams and emitting close
    child.stdin!.destroy();
    child.stdout!.destroy();
    child.stderr!.destroy();
    child.emit("close", 0, null);

    // dispose should be safe after child exit
    adapter.dispose();
  });

  it("passes explicit env overrides as strings", async () => {
    await createAdapterHarness({
      pid: 4444,
      argv: ["node", "-e", "process.exit(0)"],
      env: { FOO: "bar", COUNT: "12", DROP_ME: undefined },
    });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { env?: Record<string, string> };
    };
    expect(spawnArgs.options?.env).toEqual({ FOO: "bar", COUNT: "12" });
  });
});
