// Process supervisor shutdown tests cover gateway-owned lifecycle fencing and restart reset.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { createDeferred } from "../../test-utils/deferred.js";
import { getProcessSupervisor, shutdownProcessSupervisor } from "./index.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { SpawnProcessAdapter } from "./types.js";

const { createChildAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

type StubChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  killMock: ReturnType<typeof vi.fn>;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function createStubChildAdapter(options?: {
  onKill?: (signal: NodeJS.Signals | undefined, adapter: StubChildAdapter) => void;
}): StubChildAdapter {
  let resolveWait!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void;
  const wait = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    resolveWait = resolve;
  });
  const killMock = vi.fn();
  const adapter: StubChildAdapter = {
    pid: 1234,
    onStdout: () => undefined,
    onStderr: () => undefined,
    wait: async () => wait,
    kill: (signal) => {
      killMock(signal);
      options?.onKill?.(signal, adapter);
    },
    dispose: () => undefined,
    killMock,
    settle: (code, signal = null) => resolveWait({ code, signal }),
  };
  return adapter;
}

function spawnChild(supervisor: ReturnType<typeof createProcessSupervisor>, sessionId: string) {
  return supervisor.spawn({
    backendId: "test",
    mode: "child",
    sessionId,
    argv: [process.execPath, "-e", "setInterval(() => {}, 1_000)"],
  });
}

describe("process supervisor shutdown", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("fences new starts and waits for active runs to exit", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        if (signal === "SIGKILL") {
          current.settle(null, signal);
        }
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, "shutdown-active");
    const shutdownPromise = supervisor.shutdown();

    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    await expect(spawnChild(supervisor, "shutdown-rejected")).rejects.toThrow(
      "process supervisor is shut down",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(shutdownPromise).resolves.toBeUndefined();
    await expect(run.wait()).resolves.toMatchObject({
      reason: "manual-cancel",
      exitSignal: "SIGKILL",
    });
  });

  it("cancels and awaits runs whose adapters are still starting", async () => {
    const startup = createDeferred<StubChildAdapter>();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => current.settle(null, signal ?? "SIGTERM"),
    });
    createChildAdapterMock.mockReturnValueOnce(startup.promise);

    const supervisor = createProcessSupervisor();
    const pendingRun = spawnChild(supervisor, "shutdown-starting");
    let shutdownSettled = false;
    const shutdownPromise = supervisor.shutdown().then(() => {
      shutdownSettled = true;
    });

    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    startup.resolve(adapter);
    await shutdownPromise;

    const run = await pendingRun;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
  });

  it("creates a fresh process-wide supervisor after a lifecycle restart", async () => {
    await drainGlobalSingletonLifecycleState("restart");
    await shutdownProcessSupervisor();
    const first = getProcessSupervisor();
    await expect(
      first.spawn({ backendId: "test", mode: "child", sessionId: "stopped", argv: [] }),
    ).rejects.toThrow("process supervisor is shut down");

    await drainGlobalSingletonLifecycleState("restart");
    const second = getProcessSupervisor();
    expect(second).not.toBe(first);

    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(adapter);
    const run = await second.spawn({
      backendId: "test",
      mode: "child",
      sessionId: "restarted",
      argv: [process.execPath, "-e", ""],
    });
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit" });
    await drainGlobalSingletonLifecycleState("close");
  });
});
