import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  scheduleGatewaySigusr1Restart: vi.fn(),
  writeRestartSentinel: vi.fn(async () => "/tmp/restart-sentinel.json"),
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: mocks.scheduleGatewaySigusr1Restart,
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "Run: openclaw doctor --non-interactive",
  writeRestartSentinel: mocks.writeRestartSentinel,
}));

import { restartHandlers } from "./restart.js";

const noop = () => false;

describe("gateway.restart", () => {
  beforeEach(() => {
    mocks.scheduleGatewaySigusr1Restart.mockReset();
    mocks.writeRestartSentinel.mockClear();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules a soft SIGUSR1 restart", async () => {
    const requestGatewayShutdown = vi.fn();
    const respond = vi.fn();

    await restartHandlers["gateway.restart"]({
      req: { type: "req", id: "r1", method: "gateway.restart" },
      params: { mode: "soft", delayMs: 0, reason: "unit-test" },
      client: null,
      isWebchatConnect: noop,
      respond,
      context: {
        requestGatewayShutdown,
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        mode: "soft",
        delayMs: 0,
        reason: "unit-test",
      }),
      undefined,
    );
    expect(mocks.writeRestartSentinel).toHaveBeenCalledOnce();
    expect(mocks.scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: 0,
      reason: "unit-test",
    });
    expect(requestGatewayShutdown).not.toHaveBeenCalled();
  });

  it("requests hard shutdown after the configured delay", async () => {
    vi.useFakeTimers();
    const requestGatewayShutdown = vi.fn();
    const respond = vi.fn();

    await restartHandlers["gateway.restart"]({
      req: { type: "req", id: "r2", method: "gateway.restart" },
      params: { mode: "hard", delayMs: 5, reason: "unit-test", restartExpectedMs: 1200 },
      client: null,
      isWebchatConnect: noop,
      respond,
      context: {
        requestGatewayShutdown,
      } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        ok: true,
        mode: "hard",
        delayMs: 5,
        reason: "unit-test",
        restartExpectedMs: 1200,
      }),
      undefined,
    );
    expect(mocks.scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
    expect(requestGatewayShutdown).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5);

    expect(requestGatewayShutdown).toHaveBeenCalledWith({
      reason: "unit-test",
      restartExpectedMs: 1200,
      exitAfterClose: true,
    });
  });
});
