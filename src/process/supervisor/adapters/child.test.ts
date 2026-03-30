import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnWithFallbackMock, killProcessTreeMock } = vi.hoisted(() => ({
  spawnWithFallbackMock: vi.fn(),
  killProcessTreeMock: vi.fn(),
}));

vi.mock("../../spawn-utils.js", () => ({
  spawnWithFallback: spawnWithFallbackMock,
}));

vi.mock("../../kill-tree.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

let createChildAdapter: typeof import("./child.js").createChildAdapter;

function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  child.kill = killMock as ChildProcess["kill"];
  const emitClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.emit("exit", code, signal);
  };
  return { child, killMock, emitClose, emitExit };
}

async function createAdapterHarness(params?: {
  pid?: number;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}) {
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
  const originalServiceMarker = process.env.OPENCLAW_SERVICE_MARKER;

  beforeEach(async () => {
    vi.resetModules();
    ({ createChildAdapter } = await import("./child.js"));
    spawnWithFallbackMock.mockClear();
    killProcessTreeMock.mockClear();
    delete process.env.OPENCLAW_SERVICE_MARKER;
    vi.useRealTimers();
  });

  afterAll(() => {
    if (originalServiceMarker === undefined) {
      delete process.env.OPENCLAW_SERVICE_MARKER;
    } else {
      process.env.OPENCLAW_SERVICE_MARKER = originalServiceMarker;
    }
  });

  afterEach(() => {
    vi.useRealTimers();
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
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("uses direct child.kill for non-SIGKILL signals", async () => {
    const { adapter, killMock } = await createAdapterHarness({ pid: 7654 });

    adapter.kill("SIGTERM");

    expect(killProcessTreeMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith("SIGTERM");
  });

  it("wait does not settle immediately on SIGKILL", async () => {
    vi.useFakeTimers();
    const { adapter } = await createAdapterHarness({ pid: 4567 });

    const waitPromise = adapter.wait();
    const settled = vi.fn();
    void waitPromise.then(() => settled());

    adapter.kill();

    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3999);
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(waitPromise).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("prefers real child close over the SIGKILL fallback settle", async () => {
    vi.useFakeTimers();
    const { adapter, emitClose, killMock } = await (async () => {
      const stub = createStubChild(2468);
      spawnWithFallbackMock.mockResolvedValue({
        child: stub.child,
        usedFallback: false,
      });
      const adapter = await createChildAdapter({
        argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
        stdinMode: "pipe-open",
      });
      return { ...stub, adapter };
    })();

    const waitPromise = adapter.wait();
    adapter.kill();
    emitClose(0, "SIGKILL");

    await expect(waitPromise).resolves.toEqual({ code: 0, signal: "SIGKILL" });

    await vi.advanceTimersByTimeAsync(4_001);
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: "SIGKILL" });
    expect(killMock).toHaveBeenCalledWith("SIGKILL");
  });

  it("settles wait on exit when close never arrives after SIGKILL", async () => {
    vi.useFakeTimers();
    const { adapter, emitExit } = await (async () => {
      const stub = createStubChild(1357);
      spawnWithFallbackMock.mockResolvedValue({
        child: stub.child,
        usedFallback: false,
      });
      const adapter = await createChildAdapter({
        argv: ["node", "-e", "setTimeout(() => {}, 1000)"],
        stdinMode: "pipe-open",
      });
      return { ...stub, adapter };
    })();

    const waitPromise = adapter.wait();
    adapter.kill();
    emitExit(null, "SIGKILL");

    await expect(waitPromise).resolves.toEqual({ code: null, signal: "SIGKILL" });

    await vi.advanceTimersByTimeAsync(4_001);
    await expect(adapter.wait()).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("disables detached mode in service-managed runtime", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";

    await createAdapterHarness({ pid: 7777 });

    const spawnArgs = spawnWithFallbackMock.mock.calls[0]?.[0] as {
      options?: { detached?: boolean };
      fallbacks?: Array<{ options?: { detached?: boolean } }>;
    };
    expect(spawnArgs.options?.detached).toBe(false);
    expect(spawnArgs.fallbacks ?? []).toEqual([]);
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
