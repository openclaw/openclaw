import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";

const isRestartEnabledMock = vi.fn(() => true);
const extractDeliveryInfoMock = vi.fn(() => ({
  deliveryContext: {
    channel: "slack",
    to: "slack:C123",
    accountId: "workspace-1",
  },
  threadId: "thread-42",
}));
const formatDoctorNonInteractiveHintMock = vi.fn(() => "Run: openclaw doctor --non-interactive");
const writeRestartSentinelMock = vi.fn(async (_payload: RestartSentinelPayload) => "/tmp/restart");
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({ scheduled: true, delayMs: 250 }));

vi.mock("../../config/commands.js", () => ({
  isRestartEnabled: isRestartEnabledMock,
}));

vi.mock("../../config/sessions.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

vi.mock("../../infra/restart-sentinel.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/restart-sentinel.js")>(
    "../../infra/restart-sentinel.js",
  );
  return {
    ...actual,
    formatDoctorNonInteractiveHint: formatDoctorNonInteractiveHintMock,
    writeRestartSentinel: writeRestartSentinelMock,
  };
});

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: scheduleGatewaySigusr1RestartMock,
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    info: vi.fn(),
  })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

describe("gateway tool restart continuation", () => {
  beforeEach(() => {
    isRestartEnabledMock.mockReset();
    isRestartEnabledMock.mockReturnValue(true);
    extractDeliveryInfoMock.mockReset();
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: {
        channel: "slack",
        to: "slack:C123",
        accountId: "workspace-1",
      },
      threadId: "thread-42",
    });
    formatDoctorNonInteractiveHintMock.mockReset();
    formatDoctorNonInteractiveHintMock.mockReturnValue("Run: openclaw doctor --non-interactive");
    writeRestartSentinelMock.mockReset();
    writeRestartSentinelMock.mockResolvedValue("/tmp/restart");
    scheduleGatewaySigusr1RestartMock.mockReset();
    scheduleGatewaySigusr1RestartMock.mockReturnValue({ scheduled: true, delayMs: 250 });
  });

  it("uses a flat enum for continuationKind in the tool schema", async () => {
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool();
    const continuationKind = (
      tool.parameters as {
        properties?: {
          continuationKind?: {
            type?: string;
            enum?: string[];
            anyOf?: unknown[];
          };
        };
      }
    ).properties?.continuationKind;

    expect(continuationKind).toEqual(
      expect.objectContaining({
        type: "string",
        enum: ["systemEvent", "agentTurn"],
      }),
    );
    expect(continuationKind).not.toHaveProperty("anyOf");
  });

  it("instructs agents to use continuationMessage when a restart still needs a reply", async () => {
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool();

    expect(tool.description).toContain("still owe the user a reply");
    expect(tool.description).toContain("continuationMessage");
    expect(tool.description).toContain("do not write restart sentinel files directly");
  });

  it("writes an agentTurn continuation into the restart sentinel", async () => {
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    const result = await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "continue after reboot",
      note: "Gateway restarting now",
      continuationMessage: "Reply with exactly: Yay! I did it!",
    });

    expect(writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restart",
        status: "ok",
        sessionKey: "agent:main:main",
        deliveryContext: {
          channel: "slack",
          to: "slack:C123",
          accountId: "workspace-1",
        },
        threadId: "thread-42",
        message: "Gateway restarting now",
        continuation: {
          kind: "agentTurn",
          message: "Reply with exactly: Yay! I did it!",
        },
      }),
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith({
      delayMs: 250,
      reason: "continue after reboot",
    });
    expect(result?.details).toEqual({ scheduled: true, delayMs: 250 });
  });

  it("defaults session-scoped restarts to a success continuation", async () => {
    const { createGatewayTool } = await import("./gateway-tool.js");
    const { DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE } =
      await import("../../infra/restart-sentinel.js");
    const tool = createGatewayTool({
      agentSessionKey: "agent:main:main",
      config: {},
    });

    await tool.execute?.("tool-call-1", {
      action: "restart",
      delayMs: 250,
      reason: "restart requested",
    });

    expect(writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        continuation: {
          kind: "agentTurn",
          message: DEFAULT_RESTART_SUCCESS_CONTINUATION_MESSAGE,
        },
      }),
    );
  });
});
