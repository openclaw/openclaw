import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn(),
  callGateway: vi.fn(),
  note: vi.fn(),
  healthCommand: vi.fn(),
  formatHealthCheckFailure: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
  callGateway: mocks.callGateway,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./health.js", () => ({
  healthCommand: mocks.healthCommand,
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: mocks.formatHealthCheckFailure,
}));

import { checkGatewayHealth } from "./doctor-gateway-health.js";

describe("checkGatewayHealth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildGatewayConnectionDetails.mockReturnValue({
      message: "Gateway target: ws://127.0.0.1:18789",
    });
    mocks.formatHealthCheckFailure.mockReturnValue("formatted health failure");
  });

  it("reports pairing-required failures without saying gateway is down", async () => {
    mocks.healthCommand.mockRejectedValue(new Error("gateway closed (1008): pairing required"));

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result = await checkGatewayHealth({ runtime, cfg: { gateway: {} } });

    expect(result).toEqual({ healthOk: false });
    expect(mocks.note).toHaveBeenCalledWith(
      "Gateway requires pairing before this check can run.",
      "Gateway",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      "Gateway target: ws://127.0.0.1:18789",
      "Gateway connection",
    );
    expect(mocks.note).not.toHaveBeenCalledWith("Gateway not running.", "Gateway");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("still reports gateway-not-running for non-pairing closed connections", async () => {
    mocks.healthCommand.mockRejectedValue(new Error("gateway closed (1006): connect failed"));

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result = await checkGatewayHealth({ runtime, cfg: { gateway: {} } });

    expect(result).toEqual({ healthOk: false });
    expect(mocks.note).toHaveBeenCalledWith("Gateway not running.", "Gateway");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("surfaces non-gateway failures through formatted health errors", async () => {
    mocks.healthCommand.mockRejectedValue(new Error("unexpected health check failure"));

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result = await checkGatewayHealth({ runtime, cfg: { gateway: {} } });

    expect(result).toEqual({ healthOk: false });
    expect(runtime.error).toHaveBeenCalledWith("formatted health failure");
  });
});
