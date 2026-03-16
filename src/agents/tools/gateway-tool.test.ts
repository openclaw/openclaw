import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@mariozechner/pi-ai/oauth",
  () => ({
    getOAuthApiKey: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
  }),
  { virtual: true },
);

vi.mock(
  "@modelcontextprotocol/sdk/client/index.js",
  () => ({
    Client: class {},
  }),
  { virtual: true },
);

vi.mock(
  "@modelcontextprotocol/sdk/client/stdio.js",
  () => ({
    StdioClientTransport: class {},
  }),
  { virtual: true },
);

const writeRestartSentinelMock = vi.fn();
const transitionRestartSentinelStatusMock = vi.fn();
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true }));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: () => ({
    deliveryContext: { channel: "telegram", to: "7174833131" },
    threadId: undefined,
  }),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "doctor-hint",
  writeRestartSentinel: (...args: unknown[]) => writeRestartSentinelMock(...args),
  transitionRestartSentinelStatus: (...args: unknown[]) =>
    transitionRestartSentinelStatusMock(...args),
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: (...args: unknown[]) => scheduleGatewaySigusr1RestartMock(...args),
}));

describe("gateway-tool restart sentinel hook", () => {
  beforeEach(() => {
    writeRestartSentinelMock.mockReset();
    writeRestartSentinelMock.mockResolvedValue("/tmp/restart-sentinel.json");
    transitionRestartSentinelStatusMock.mockReset();
    scheduleGatewaySigusr1RestartMock.mockReset();
    scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true });
  });

  it("skips beforeRestart when sentinel write fails", async () => {
    writeRestartSentinelMock.mockRejectedValueOnce(new Error("disk full"));
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool({ config: { commands: { restart: true } } });

    await tool.execute("call-1", { action: "restart", delayMs: 0 });

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    const [restartRequest] = scheduleGatewaySigusr1RestartMock.mock.calls[0] ?? [];
    expect(restartRequest.beforeRestart).toBeUndefined();
    expect(transitionRestartSentinelStatusMock).not.toHaveBeenCalled();
  });

  it("registers beforeRestart when sentinel write succeeds", async () => {
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool({ config: { commands: { restart: true } } });

    await tool.execute("call-2", { action: "restart", delayMs: 0 });

    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    const [restartRequest] = scheduleGatewaySigusr1RestartMock.mock.calls[0] ?? [];
    expect(typeof restartRequest.beforeRestart).toBe("function");

    await restartRequest.beforeRestart();
    expect(transitionRestartSentinelStatusMock).toHaveBeenCalledWith("in-progress", {
      allowedCurrentStatuses: ["pending"],
    });
  });
});
