import { describe, expect, it, vi } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const getActiveTaskCount = vi.fn(() => 0);
const markGatewayDraining = vi.fn();
const waitForActiveTasks = vi.fn(async (_timeoutMs: number) => ({ drained: true }));
const resetAllLanes = vi.fn();
const restartGatewayProcessWithFreshPid = vi.fn<
  () => { mode: "spawned" | "supervised" | "disabled" | "failed"; pid?: number; detail?: string }
>(() => ({ mode: "disabled" }));
const DRAIN_TIMEOUT_LOG = "drain timeout reached; proceeding with restart";
const gatewayLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", () => ({
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  restartGatewayProcessWithFreshPid: () => restartGatewayProcessWithFreshPid(),
}));

vi.mock("../../process/command-queue.js", () => ({
  getActiveTaskCount: () => getActiveTaskCount(),
  markGatewayDraining: () => markGatewayDraining(),
  waitForActiveTasks: (timeoutMs: number) => waitForActiveTasks(timeoutMs),
  resetAllLanes: () => resetAllLanes(),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => gatewayLog,
}));

function removeNewSignalListeners(
  signal: NodeJS.Signals,
  existing: Set<(...args: unknown[]) => void>,
) {
  for (const listener of process.listeners(signal)) {
    const fn = listener as (...args: unknown[]) => void;
    if (!existing.has(fn)) {
      process.removeListener(signal, fn);
    }
  }
}

async function withIsolatedSignals(run: () => Promise<void>) {
  const beforeSigterm = new Set(
    process.listeners("SIGTERM") as Array<(...args: unknown[]) => void>,
  );
  const beforeSigint = new Set(process.listeners("SIGINT") as Array<(...args: unknown[]) => void>);
  const beforeSigusr1 = new Set(
    process.listeners("SIGUSR1") as Array<(...args: unknown[]) => void>,
  );
  try {
    await run();
  } finally {
    removeNewSignalListeners("SIGTERM", beforeSigterm);
    removeNewSignalListeners("SIGINT", beforeSigint);
    removeNewSignalListeners("SIGUSR1", beforeSigusr1);
  }
}

function createRuntimeWithExitSignal(exitCallOrder?: string[]) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      exitCallOrder?.push("exit");
      resolveExit(code);
    }),
  };
  return { runtime, exited };
}

type GatewayCloseFn = (...args: unknown[]) => Promise<void>;
type LoopRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

function createSignaledStart(close: GatewayCloseFn) {
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn(async () => {
    resolveStarted?.();
    return { close };
  });
  return { start, started };
}

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: LoopRuntime;
  lockPort?: number;
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    lockPort: params.lockPort,
  });
  return { loopPromise };
}

async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function createSignaledLoopHarness(exitCallOrder?: string[]) {
  const close = vi.fn(async () => {});
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

describe("runGatewayLoop", () => {
  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async () => {
      const { close, runtime, exited } = await createSignaledLoopHarness();

      process.emit("SIGTERM");

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("restarts after SIGUSR1 even when drain times out, and resets lanes for the new iteration", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async () => {
      getActiveTaskCount.mockReturnValueOnce(2).mockReturnValueOnce(0);
      waitForActiveTasks.mockResolvedValueOnce({ drained: false });

      type StartServer = () => Promise<{
        close: (opts: { reason: string; restartExpectedMs: number | null }) => Promise<void>;
      }>;

      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});

      const start = vi.fn<StartServer>();
      let resolveFirst: (() => void) | null = null;
      const startedFirst = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveFirst?.();
        return { close: closeFirst };
      });

      let resolveSecond: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveSecond?.();
        return { close: closeSecond };
      });

      start.mockRejectedValueOnce(new Error("stop-loop"));

      const { runGatewayLoop } = await import("./run-loop.js");
      const runtime = {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      };
      const loopPromise = runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await startedFirst;
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      process.emit("SIGUSR1");

      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForActiveTasks).toHaveBeenCalledWith(30_000);
      expect(markGatewayDraining).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(DRAIN_TIMEOUT_LOG);
      expect(closeFirst).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(1);
      expect(resetAllLanes).toHaveBeenCalledTimes(1);

      process.emit("SIGUSR1");

      await expect(loopPromise).rejects.toThrow("stop-loop");
      expect(closeSecond).toHaveBeenCalledWith({
        reason: "gateway restarting",
        restartExpectedMs: 1500,
      });
      expect(markGatewaySigusr1RestartHandled).toHaveBeenCalledTimes(2);
      expect(markGatewayDraining).toHaveBeenCalledTimes(2);
      expect(resetAllLanes).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
    });
  });

  it("releases the lock before exiting on spawned restart", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async () => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({
        release: lockRelease,
      });

      // Override process-respawn to return "spawned" mode
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "spawned",
        pid: 9999,
      });

      const exitCallOrder: string[] = [];
      const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
      lockRelease.mockImplementation(async () => {
        exitCallOrder.push("lockRelease");
      });

      process.emit("SIGUSR1");

      await exited;
      expect(lockRelease).toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(0);
      expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
    });
  });

  it("forwards lockPort to initial and restart lock acquisitions", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async () => {
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "disabled" });

      const start = vi
        .fn()
        .mockResolvedValueOnce({ close: closeFirst })
        .mockResolvedValueOnce({ close: closeSecond })
        .mockRejectedValueOnce(new Error("stop-loop"));
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const { runGatewayLoop } = await import("./run-loop.js");
      const loopPromise = runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        lockPort: 18789,
      });

      await new Promise<void>((resolve) => setImmediate(resolve));
      process.emit("SIGUSR1");
      await new Promise<void>((resolve) => setImmediate(resolve));
      process.emit("SIGUSR1");

      await expect(loopPromise).rejects.toThrow("stop-loop");
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(1, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(2, { port: 18789 });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(3, { port: 18789 });
    });
  });

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async () => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(new Error("lock timeout"));

      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await createSignaledLoopHarness();
      process.emit("SIGUSR1");

      await expect(exited).resolves.toBe(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("failed to reacquire gateway lock for in-process restart"),
      );
    });
  });
});

describe("gateway discover routing helpers", () => {
  it("prefers resolved service host over TXT hints", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      lanHost: "evil.example.com",
      tailnetDns: "evil.example.com",
    };
    expect(pickBeaconHost(beacon)).toBe("10.0.0.2");
  });

  it("prefers resolved service port over TXT gatewayPort", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      host: "10.0.0.2",
      port: 18789,
      gatewayPort: 12345,
    };
    expect(pickGatewayPort(beacon)).toBe(18789);
  });

  it("falls back to TXT host/port when resolve data is missing", () => {
    const beacon: GatewayBonjourBeacon = {
      instanceName: "Test",
      lanHost: "test-host.local",
      gatewayPort: 18789,
    };
    expect(pickBeaconHost(beacon)).toBe("test-host.local");
    expect(pickGatewayPort(beacon)).toBe(18789);
  });
});
