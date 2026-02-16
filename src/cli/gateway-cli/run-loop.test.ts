import { describe, expect, it, vi } from "vitest";
import type { GatewayBonjourBeacon } from "../../infra/bonjour-discovery.js";
import { pickBeaconHost, pickGatewayPort } from "./discover.js";

const acquireGatewayLock = vi.fn(async () => ({
  release: vi.fn(async () => {}),
}));
const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
const markGatewaySigusr1RestartHandled = vi.fn();
const getActiveTaskCount = vi.fn(() => 0);
const waitForActiveTasks = vi.fn(async () => ({ drained: true }));
const resetAllLanes = vi.fn();
const DRAIN_TIMEOUT_LOG = "drain timeout reached; proceeding with restart";
const gatewayLog = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: () => acquireGatewayLock(),
}));

vi.mock("../../infra/restart.js", () => ({
  consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
  isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
  markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  restartGatewayProcessWithFreshPid: () => ({ mode: "skipped" }),
}));

vi.mock("../../process/command-queue.js", () => ({
  getActiveTaskCount: () => getActiveTaskCount(),
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

describe("runGatewayLoop", () => {
  it("restarts after SIGUSR1 even when drain times out, and resets lanes for the new iteration", async () => {
    vi.clearAllMocks();
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

    const beforeSigterm = new Set(
      process.listeners("SIGTERM") as Array<(...args: unknown[]) => void>,
    );
    const beforeSigint = new Set(
      process.listeners("SIGINT") as Array<(...args: unknown[]) => void>,
    );
    const beforeSigusr1 = new Set(
      process.listeners("SIGUSR1") as Array<(...args: unknown[]) => void>,
    );

    const { runGatewayLoop } = await import("./run-loop.js");
    const loopPromise = runGatewayLoop({
      start,
      runtime: {
        exit: vi.fn(),
      } as { exit: (code: number) => never },
    });

    try {
      await startedFirst;
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));

      process.emit("SIGUSR1");

      await startedSecond;
      expect(start).toHaveBeenCalledTimes(2);
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(waitForActiveTasks).toHaveBeenCalledWith(30_000);
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
      expect(resetAllLanes).toHaveBeenCalledTimes(2);
    } finally {
      removeNewSignalListeners("SIGTERM", beforeSigterm);
      removeNewSignalListeners("SIGINT", beforeSigint);
      removeNewSignalListeners("SIGUSR1", beforeSigusr1);
    }
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
