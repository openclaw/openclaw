import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { checkGatewayHealth } from "./doctor-gateway-health.js";

const mocks = vi.hoisted(() => ({
  buildGatewayConnectionDetails: vi.fn(() => ({ message: "gateway connection details" })),
  callGateway: vi.fn(),
  formatHealthCheckFailure: vi.fn(() => "formatted health failure"),
  healthCommand: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    ...actual,
    buildGatewayConnectionDetails: mocks.buildGatewayConnectionDetails,
    callGateway: mocks.callGateway,
  };
});

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: mocks.formatHealthCheckFailure,
}));

vi.mock("./health.js", () => ({
  healthCommand: mocks.healthCommand,
}));

describe("checkGatewayHealth", () => {
  const cfg: OpenClawConfig = { gateway: { mode: "local" } };
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildGatewayConnectionDetails.mockReturnValue({
      message: "gateway connection details",
    });
    mocks.callGateway.mockResolvedValue({});
    mocks.healthCommand.mockResolvedValue(undefined);
  });

  it("uses a direct health probe and skips channel status in non-interactive fast path", async () => {
    const result = await checkGatewayHealth({
      runtime,
      cfg,
      timeoutMs: 1234,
      nonInteractive: true,
    });

    expect(result).toEqual({ healthOk: true });
    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledTimes(1);
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "health",
      timeoutMs: 1234,
      config: cfg,
    });
    expect(mocks.callGateway).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: "channels.status" }),
    );
  });

  it("keeps channel status probing in deep non-interactive mode", async () => {
    await checkGatewayHealth({
      runtime,
      cfg,
      timeoutMs: 1234,
      nonInteractive: true,
      deep: true,
    });

    expect(mocks.healthCommand).not.toHaveBeenCalled();
    expect(mocks.callGateway.mock.calls.map(([arg]) => arg.method)).toEqual([
      "health",
      "channels.status",
    ]);
  });
});
