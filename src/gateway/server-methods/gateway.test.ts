import { describe, expect, it, vi } from "vitest";

vi.mock("../../infra/restart.js", () => {
  return {
    scheduleGatewaySigusr1Restart: vi.fn(() => ({
      ok: true,
      pid: 123,
      signal: "SIGUSR1",
      delayMs: 2000,
      reason: "gateway.restart",
      mode: "emit",
    })),
  };
});

vi.mock("../../infra/restart-sentinel.js", () => {
  return {
    formatDoctorNonInteractiveHint: vi.fn(() => "Run: openclaw doctor --non-interactive"),
    writeRestartSentinel: vi.fn(async () => "C:/tmp/restart-sentinel.json"),
  };
});

import { gatewayHandlers } from "./gateway.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { writeRestartSentinel } from "../../infra/restart-sentinel.js";

function createCtx() {
  return {
    logGateway: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: () => ({ warn: vi.fn() }),
    },
  } as any;
}

describe("gateway.restart handler", () => {
  it("accepts restartDelayMs as numeric string and clamps to 0..60000", async () => {
    const respond = vi.fn();
    const ctx = createCtx();

    await gatewayHandlers["gateway.restart"]({
      req: { type: "req", id: "1", method: "gateway.restart", params: {} },
      params: {
        restartDelayMs: "65000",
        reason: "test",
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: ctx,
    });

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: 60_000, reason: "test" }),
    );
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, restart: expect.any(Object) }),
      undefined,
      undefined,
    );
  });

  it("logs when restart sentinel write fails (does not throw)", async () => {
    vi.mocked(writeRestartSentinel).mockRejectedValueOnce(new Error("disk full"));

    const respond = vi.fn();
    const ctx = createCtx();

    await gatewayHandlers["gateway.restart"]({
      req: { type: "req", id: "1", method: "gateway.restart", params: {} },
      params: {
        restartDelayMs: 10,
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: ctx,
    });

    expect(ctx.logGateway.warn).toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ ok: true, sentinel: expect.any(Object) }),
      undefined,
      undefined,
    );
  });
});
