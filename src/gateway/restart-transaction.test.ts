import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../infra/restart-sentinel.js";
import type { RestartTransaction } from "../infra/restart-transaction.js";

const mocks = vi.hoisted(() => ({
  getRun: vi.fn(),
  scheduleGatewaySigusr1Restart: vi.fn((_opts?: unknown) => ({
    ok: true,
    pid: 123,
    signal: "SIGUSR1",
    delayMs: 0,
    mode: "emit",
    coalesced: false,
    cooldownMsApplied: 0,
  })),
  writeRestartTransaction: vi.fn<(tx: RestartTransaction) => Promise<string>>(
    async () => "/tmp/restart-transaction.json",
  ),
  updateRestartTransaction: vi.fn<
    (
      updater: (current: RestartTransaction | null) => RestartTransaction | null,
    ) => Promise<RestartTransaction | null>
  >(async () => null),
  writeRestartSentinel: vi.fn<(payload: RestartSentinelPayload) => Promise<string>>(
    async () => "/tmp/restart-sentinel.json",
  ),
  abortForRestart: vi.fn(),
}));

vi.mock("../auto-reply/reply/reply-run-registry.js", () => ({
  replyRunRegistry: {
    get: (sessionKey: string) => mocks.getRun(sessionKey),
  },
}));

vi.mock("../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: (opts?: unknown) => mocks.scheduleGatewaySigusr1Restart(opts),
}));

vi.mock("../infra/restart-transaction.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-transaction.js")>(
    "../infra/restart-transaction.js",
  );
  return {
    ...actual,
    writeRestartTransaction: (tx: RestartTransaction) => mocks.writeRestartTransaction(tx),
    updateRestartTransaction: (
      updater: (current: RestartTransaction | null) => RestartTransaction | null,
    ) => mocks.updateRestartTransaction(updater),
  };
});

vi.mock("../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-sentinel.js")>(
    "../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    writeRestartSentinel: (payload: RestartSentinelPayload) => mocks.writeRestartSentinel(payload),
  };
});

const { requestGatewayRestartTransaction } = await import("./restart-transaction.js");

describe("requestGatewayRestartTransaction", () => {
  beforeEach(() => {
    mocks.getRun.mockReset();
    mocks.scheduleGatewaySigusr1Restart.mockClear();
    mocks.writeRestartTransaction.mockClear();
    mocks.updateRestartTransaction.mockClear();
    mocks.writeRestartSentinel.mockClear();
    mocks.abortForRestart.mockClear();
  });

  it("uses terminal-handoff mode for an active top-level run", async () => {
    mocks.getRun.mockReturnValue({
      sessionId: "turn-1",
      phase: "running",
      abortForRestart: mocks.abortForRestart,
    });

    const result = await requestGatewayRestartTransaction({
      payload: {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "agent:main:main",
        message: "Restarting now",
      },
      entryPoint: "gateway.restart",
      reason: "gateway.restart",
    });

    expect(result.mode).toBe("terminal-handoff");
    expect(result.transaction.turnId).toBe("turn-1");
    expect(result.transaction.interruptedTurn).toMatchObject({
      sessionKey: "agent:main:main",
      phase: "running",
      resumeEligible: false,
    });
    expect(mocks.abortForRestart).toHaveBeenCalledTimes(1);
    expect(mocks.writeRestartSentinel).toHaveBeenCalled();
  });

  it("uses drain-then-restart mode when no active run exists", async () => {
    mocks.getRun.mockReturnValue(undefined);

    const result = await requestGatewayRestartTransaction({
      payload: {
        kind: "restart",
        status: "ok",
        ts: Date.now(),
        sessionKey: "agent:main:main",
      },
      entryPoint: "gateway.restart",
      reason: "gateway.restart",
    });

    expect(result.mode).toBe("drain-then-restart");
    expect(result.transaction.interruptedTurn).toBeNull();
    expect(mocks.abortForRestart).not.toHaveBeenCalled();
    expect(mocks.scheduleGatewaySigusr1Restart).toHaveBeenCalledTimes(1);
  });
});
