// Process supervisor tests cover lifecycle, restart, and termination behavior.
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnProcessAdapter } from "./types.js";

const { createChildAdapterMock, createPtyAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: createPtyAdapterMock,
}));

let createProcessSupervisor: typeof import("./supervisor.js").createProcessSupervisor;

type ProcessSupervisor = ReturnType<typeof createProcessSupervisor>;
type SpawnOptions = Parameters<ProcessSupervisor["spawn"]>[0];
type ChildSpawnOptions = Omit<Extract<SpawnOptions, { mode: "child" }>, "backendId" | "mode">;
type ChildAdapter = SpawnProcessAdapter<NodeJS.Signals | null>;
type StubChildAdapter = ChildAdapter & {
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
  killMock: ReturnType<typeof vi.fn>;
  forceKillAndWaitMock: ReturnType<typeof vi.fn>;
  disposeMock: ReturnType<typeof vi.fn>;
};

function createWriteStdoutArgv(output: string): string[] {
  if (process.platform === "win32") {
    return [process.execPath, "-e", `process.stdout.write(${JSON.stringify(output)})`];
  }
  return ["/usr/bin/printf", "%s", output];
}

function createSilentIdleArgv(): string[] {
  return [process.execPath, "-e", "setInterval(() => {}, 1_000)"];
}

function createStubChildAdapter(options?: {
  pid?: number;
  onKill?: (signal: NodeJS.Signals | undefined, adapter: StubChildAdapter) => void;
  forceKillAndWait?: (adapter: StubChildAdapter) => Promise<boolean>;
  probeProcessTreeAlive?: (adapter: StubChildAdapter) => Promise<boolean | undefined>;
}): StubChildAdapter {
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const stderrListeners: Array<(chunk: string) => void> = [];
  let resolveWait:
    | ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
    | null = null;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      resolveWait = resolve;
    },
  );
  const killMock = vi.fn();
  const forceKillAndWaitMock = vi.fn();
  const disposeMock = vi.fn();
  let waitSettled = false;
  const adapter: StubChildAdapter = {
    pid: options?.pid ?? 1234,
    stdin: undefined,
    onStdout: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderr: (listener) => {
      stderrListeners.push(listener);
    },
    wait: async () => await waitPromise,
    kill: (signal) => {
      killMock(signal);
      options?.onKill?.(signal, adapter);
    },
    forceKillAndWait: async () => {
      forceKillAndWaitMock();
      adapter.kill("SIGKILL");
      if (options?.forceKillAndWait) {
        return await options.forceKillAndWait(adapter);
      }
      await waitPromise;
      return true;
    },
    probeProcessTreeAlive: async () =>
      options?.probeProcessTreeAlive ? await options.probeProcessTreeAlive(adapter) : !waitSettled,
    dispose: () => {
      disposeMock();
    },
    emitStdout: (chunk) => {
      for (const listener of stdoutListeners) {
        listener(chunk);
      }
    },
    emitStderr: (chunk) => {
      for (const listener of stderrListeners) {
        listener(chunk);
      }
    },
    settle: (code, signal = null) => {
      waitSettled = true;
      resolveWait?.({ code, signal });
      resolveWait = null;
    },
    killMock,
    forceKillAndWaitMock,
    disposeMock,
  };

  return adapter;
}

async function spawnChild(supervisor: ProcessSupervisor, options: ChildSpawnOptions) {
  return supervisor.spawn({
    ...options,
    backendId: "test",
    mode: "child",
  });
}

describe("process supervisor", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ createProcessSupervisor } = await import("./supervisor.js"));
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("spawns child runs and captures output", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createWriteStdoutArgv("ok"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    adapter.emitStdout("ok");
    adapter.settle(0);

    const exit = await run.wait();
    expect(exit.reason).toBe("exit");
    expect(exit.exitCode).toBe(0);
    expect(exit.stdout).toBe("ok");
    expect(adapter.disposeMock).toHaveBeenCalledTimes(1);
  });

  it("enforces no-output timeout for silent processes", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 300,
      noOutputTimeoutMs: 5,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    await vi.advanceTimersByTimeAsync(5);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("escalates cancellation to SIGKILL when graceful shutdown does not settle", async () => {
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
    const run = await spawnChild(supervisor, {
      sessionId: "s1",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    run.cancel("manual-cancel");

    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(4_999);
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");

    await vi.advanceTimersByTimeAsync(1);
    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(exit.reason).toBe("manual-cancel");
    expect(exit.exitSignal).toBe("SIGKILL");
  });

  it("cancels prior scoped run when replaceExistingScope is enabled", async () => {
    const first = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    const second = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const supervisor = createProcessSupervisor();
    const firstRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      argv: [process.execPath, "-e", "setTimeout(() => {}, 80)"],
      timeoutMs: 1_000,
      stdinMode: "pipe-open",
    });

    const secondRun = await spawnChild(supervisor, {
      sessionId: "s1",
      scopeKey: "scope:a",
      replaceExistingScope: true,
      argv: createWriteStdoutArgv("new"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    second.emitStdout("new");
    second.settle(0);

    const firstExit = await firstRun.wait();
    const secondExit = await secondRun.wait();
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(["manual-cancel", "signal"]).toContain(firstExit.reason);
    expect(secondExit.reason).toBe("exit");
    expect(secondExit.stdout).toBe("new");
  });

  it("rejects a duplicate run id before it can replace scoped ownership", async () => {
    const first = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(first);

    const supervisor = createProcessSupervisor();
    const firstRun = await spawnChild(supervisor, {
      runId: "shared-run-id",
      sessionId: "first",
      scopeKey: "scope:duplicate",
      argv: createSilentIdleArgv(),
      stdinMode: "pipe-closed",
    });

    await expect(
      spawnChild(supervisor, {
        runId: "shared-run-id",
        sessionId: "second",
        scopeKey: "scope:duplicate",
        argv: createSilentIdleArgv(),
        stdinMode: "pipe-closed",
      }),
    ).rejects.toThrow(/run id shared-run-id already exists/i);
    expect(createChildAdapterMock).toHaveBeenCalledTimes(1);

    first.settle(0);
    await firstRun.wait();
  });

  it("cancels and waits for every active run in one scope", async () => {
    const target = createStubChildAdapter();
    const other = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValueOnce(target).mockResolvedValueOnce(other);

    const supervisor = createProcessSupervisor();
    const targetRun = await spawnChild(supervisor, {
      sessionId: "target",
      scopeKey: "scope:target",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });
    expect(createChildAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({ forceDetachedProcessGroup: true }),
    );
    const otherRun = await spawnChild(supervisor, {
      sessionId: "other",
      scopeKey: "scope:other",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    let settled = false;
    const cancellation = supervisor
      .cancelScopeAndWait("scope:target", { timeoutMs: 1_000 })
      .then(() => {
        settled = true;
      });

    await vi.waitFor(() => expect(target.killMock).toHaveBeenCalledWith("SIGTERM"));
    expect(other.killMock).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    target.settle(null, "SIGTERM");
    await cancellation;
    expect(settled).toBe(true);

    other.settle(0);
    await Promise.all([targetRun.wait(), otherRun.wait()]);
  });

  it("drains a scoped run that was still spawning when cancellation began", async () => {
    const adapter = createStubChildAdapter();
    let resolveAdapter: ((value: StubChildAdapter) => void) | undefined;
    createChildAdapterMock.mockImplementationOnce(
      async () =>
        await new Promise<StubChildAdapter>((resolve) => {
          resolveAdapter = resolve;
        }),
    );

    const supervisor = createProcessSupervisor();
    const spawnPromise = spawnChild(supervisor, {
      sessionId: "starting",
      scopeKey: "scope:starting",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });
    const cancellation = supervisor.cancelScopeAndWait("scope:starting", { timeoutMs: 1_000 });

    resolveAdapter?.(adapter);
    const run = await spawnPromise;
    await vi.waitFor(() => expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM"));

    let settled = false;
    void cancellation.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    adapter.settle(null, "SIGTERM");
    await Promise.all([cancellation, run.wait()]);
  });

  it("retains a late spawn proof when its root exits immediately on drain", async () => {
    let confirmTreeExit!: (confirmed: boolean) => void;
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        if (signal === "SIGTERM") {
          current.settle(null, signal);
        }
      },
      forceKillAndWait: async () =>
        await new Promise<boolean>((resolve) => {
          confirmTreeExit = resolve;
        }),
      probeProcessTreeAlive: async () => true,
    });
    let resolveAdapter: ((value: StubChildAdapter) => void) | undefined;
    createChildAdapterMock.mockImplementationOnce(
      async () =>
        await new Promise<StubChildAdapter>((resolve) => {
          resolveAdapter = resolve;
        }),
    );

    const supervisor = createProcessSupervisor();
    const spawnPromise = spawnChild(supervisor, {
      sessionId: "late-root-exit",
      scopeKey: "scope:late-root-exit",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });
    const cancellation = supervisor.cancelScopeAndWait("scope:late-root-exit", {
      timeoutMs: 1_000,
    });

    resolveAdapter?.(adapter);
    const run = await spawnPromise;
    await run.wait();
    await vi.waitFor(() => expect(adapter.forceKillAndWaitMock).toHaveBeenCalledTimes(1));

    let drained = false;
    void cancellation.then(
      () => {
        drained = true;
      },
      () => undefined,
    );
    await Promise.resolve();
    expect(drained).toBe(false);

    confirmTreeExit(false);
    await expect(cancellation).rejects.toThrow(/could not confirm process-tree termination/i);
  });

  it("fails closed and keeps the scope fenced when process-tree exit is unconfirmed", async () => {
    const adapter = createStubChildAdapter({
      forceKillAndWait: async () => false,
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    await spawnChild(supervisor, {
      sessionId: "unconfirmed",
      scopeKey: "scope:unconfirmed",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });

    await expect(
      supervisor.cancelScopeAndWait("scope:unconfirmed", { timeoutMs: 1_000 }),
    ).rejects.toThrow(/could not confirm process-tree termination/i);
    await expect(
      spawnChild(supervisor, {
        sessionId: "late",
        scopeKey: "scope:unconfirmed",
        argv: createSilentIdleArgv(),
        timeoutMs: 1_000,
        stdinMode: "pipe-closed",
      }),
    ).rejects.toThrow(/being drained/i);
  });

  it("does not treat root wait settlement as process-tree termination proof", async () => {
    let confirmTreeExit!: (confirmed: boolean) => void;
    const adapter = createStubChildAdapter({
      forceKillAndWait: async () =>
        await new Promise<boolean>((resolve) => {
          confirmTreeExit = resolve;
        }),
      probeProcessTreeAlive: async () => true,
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "root-exits-first",
      scopeKey: "scope:root-exits-first",
      argv: createSilentIdleArgv(),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
    });
    let drained = false;
    const cancellation = supervisor
      .cancelScopeAndWait("scope:root-exits-first", { timeoutMs: 1_000 })
      .then(() => {
        drained = true;
      });

    adapter.settle(null, "SIGTERM");
    await run.wait();
    await Promise.resolve();
    expect(drained).toBe(false);

    confirmTreeExit(true);
    await cancellation;
    expect(drained).toBe(true);
  });

  it("applies overall timeout even for near-immediate timer firing", async () => {
    vi.useFakeTimers();
    const adapter = createStubChildAdapter({
      onKill: (signal, current) => {
        current.settle(null, signal ?? "SIGKILL");
      },
    });
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout",
      argv: createSilentIdleArgv(),
      timeoutMs: 1,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    await vi.advanceTimersByTimeAsync(1);

    const exit = await exitPromise;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("classifies a natural close after a missed overall deadline as timed out", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-timeout-race",
      argv: createSilentIdleArgv(),
      timeoutMs: 10,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    nowSpy.mockReturnValue(1_011);
    adapter.settle(0);

    const exit = await exitPromise;
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(exit.reason).toBe("overall-timeout");
    expect(exit.timedOut).toBe(true);
  });

  it("uses the refreshed no-output deadline when a missed timer races natural close", async () => {
    vi.useFakeTimers();
    const nowSpy = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    const run = await spawnChild(supervisor, {
      sessionId: "s-no-output-race",
      argv: createSilentIdleArgv(),
      timeoutMs: 100,
      noOutputTimeoutMs: 10,
      stdinMode: "pipe-closed",
    });

    const exitPromise = run.wait();
    nowSpy.mockReturnValue(1_005);
    adapter.emitStdout("progress");
    nowSpy.mockReturnValue(1_016);
    adapter.settle(0);

    const exit = await exitPromise;
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(exit.reason).toBe("no-output-timeout");
    expect(exit.noOutputTimedOut).toBe(true);
    expect(exit.timedOut).toBe(true);
  });

  it("can stream output without retaining it in RunExit payload", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    let streamed = "";
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture",
      argv: createWriteStdoutArgv("streamed"),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      captureOutput: false,
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });

    adapter.emitStdout("streamed");
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamed).toBe("streamed");
    expect(exit.stdout).toBe("");
  });

  it("bounds retained output on UTF-16 boundaries while streaming full chunks", async () => {
    const adapter = createStubChildAdapter();
    createChildAdapterMock.mockResolvedValue(adapter);

    const supervisor = createProcessSupervisor();
    let streamedStdout = "";
    let streamedStderr = "";
    const maxCapturedOutputChars = 256;
    const stdoutMarker = `[openclaw: captured stdout truncated to last ${maxCapturedOutputChars} chars]\n`;
    const stderrMarker = `[openclaw: captured stderr truncated to last ${maxCapturedOutputChars} chars]\n`;
    const retainedChars = maxCapturedOutputChars - stdoutMarker.length - 1;
    const stdoutChunk = `${"a".repeat(stdoutMarker.length)}😀${"s".repeat(retainedChars)}`;
    const stderrChunk = `${"b".repeat(stderrMarker.length)}😀${"e".repeat(retainedChars)}`;
    const run = await spawnChild(supervisor, {
      sessionId: "s-capture-cap",
      argv: createWriteStdoutArgv(stdoutChunk),
      timeoutMs: 1_000,
      stdinMode: "pipe-closed",
      maxCapturedOutputChars,
      onStdout: (chunk) => {
        streamedStdout += chunk;
      },
      onStderr: (chunk) => {
        streamedStderr += chunk;
      },
    });

    adapter.emitStdout(stdoutChunk);
    adapter.emitStderr(stderrChunk);
    adapter.settle(0);

    const exit = await run.wait();
    expect(streamedStdout).toBe(stdoutChunk);
    expect(streamedStderr).toBe(stderrChunk);
    expect(exit.stdout).toBe(`${stdoutMarker}${"s".repeat(retainedChars)}`);
    expect(exit.stderr).toBe(`${stderrMarker}${"e".repeat(retainedChars)}`);
  });
});
